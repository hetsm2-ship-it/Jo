# instamass_full.py
import os
import time
import threading
import sqlite3
import json
import base64
from typing import Optional, Dict, Any, List

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.fernet import Fernet

from instagrapi import Client
from instagrapi.exceptions import ClientError

from telegram import Update
from telegram.ext import (
    ApplicationBuilder, CommandHandler, ContextTypes, ConversationHandler,
    MessageHandler, filters
)

# ================== CONFIG ==================
TELEGRAM_TOKEN = "7676994337:AAH_CsiojGCaqJMt7ubA1s511Jm6Xy4WsXU"
BOT_OWNER_TELEGRAM_ID = 5193826370  # change to your Telegram numeric id

DB_PATH = "bot_data.sqlite"
SESSION_DIR = "insta_sessions"
os.makedirs(SESSION_DIR, exist_ok=True)

# Defaults
DEFAULT_MSG_SPEED = 0.4  # seconds between messages if user not set
LAST_N_THREADS = 10
# 🔐 Cache unlocked clients
UNLOCKED_CLIENTS = {}
PENDING_OTP = {}   # <-- yahan add karo
MAX_RECENT_MESSAGES = 30

# Conversation states for massmsg and login
LOGIN_USERNAME, LOGIN_PASSWORD, LOGIN_PASSPHRASE = range(3)
CHOOSE_MODE, CHOOSE_GC, ASK_GC_MESSAGES, ASK_DM_USERNAME, ASK_DM_MESSAGES = range(5)

# In-memory runtime control
sending_threads: Dict[int, threading.Thread] = {}
stop_flags: Dict[int, threading.Event] = {}

# Database connection pool
db_connections = {}
db_lock = threading.Lock()

# ========== Authorization Helpers ==========
def is_authorized(tg_id: int) -> bool:
    """Check if user is authorized (admin or regular authorized user)"""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM admins WHERE tg_id=?", (tg_id,))
        if cur.fetchone():
            return True
        
        cur.execute("SELECT 1 FROM authorized_users WHERE tg_id=?", (tg_id,))
        return cur.fetchone() is not None

def add_authorized_user(tg_id: int):
    """Add user to authorized_users table"""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("INSERT OR IGNORE INTO authorized_users(tg_id) VALUES(?)", (tg_id,))
        conn.commit()

def remove_authorized_user(tg_id: int):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM authorized_users WHERE tg_id=?", (tg_id,))
        conn.commit()
    # full cleanup
    full_remove_user(tg_id)
    
def full_remove_user(tg_id: int):
    """Completely remove a user and all their data"""
    with get_conn() as conn:
        cur = conn.cursor()
        # delete IG accounts
        cur.execute("DELETE FROM ig_accounts WHERE tg_id=?", (tg_id,))
        # delete saved passphrases
        cur.execute("DELETE FROM account_passphrases WHERE tg_id=?", (tg_id,))
        # delete user prefs
        cur.execute("DELETE FROM user_prefs WHERE tg_id=?", (tg_id,))
        # delete salt
        cur.execute("DELETE FROM users WHERE tg_id=?", (tg_id,))
        conn.commit()
    # also clear from memory
    if tg_id in UNLOCKED_CLIENTS:
        UNLOCKED_CLIENTS.pop(tg_id)


def remove_authorized_user(tg_id: int):
    """Remove user from authorized list and cleanup all data"""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM authorized_users WHERE tg_id=?", (tg_id,))
        conn.commit()
    # cleanup everything else
    full_remove_user(tg_id)

# ========== DB Helpers ==========
def init_db():
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            tg_id INTEGER PRIMARY KEY,
            salt BLOB
        )""")
        cur.execute("""
        CREATE TABLE IF NOT EXISTS ig_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_id INTEGER,
            ig_username TEXT,
            encrypted_blob BLOB,
            default_account INTEGER DEFAULT 0,
            session_file TEXT,
            FOREIGN KEY(tg_id) REFERENCES users(tg_id)
        )
        """)
        cur.execute("""
        CREATE TABLE IF NOT EXISTS admins (
            tg_id INTEGER PRIMARY KEY
        )
        """)
        cur.execute("""
        CREATE TABLE IF NOT EXISTS authorized_users (
            tg_id INTEGER PRIMARY KEY
        )
        """)
        # user_prefs with default speed value inserted directly
        cur.execute(f"""
        CREATE TABLE IF NOT EXISTS user_prefs (
            tg_id INTEGER PRIMARY KEY,
            speed REAL DEFAULT {DEFAULT_MSG_SPEED}
        )
        """)
        # Store passphrases for accounts
        cur.execute("""
        CREATE TABLE IF NOT EXISTS account_passphrases (
            tg_id INTEGER,
            ig_username TEXT,
            passphrase TEXT,
            PRIMARY KEY(tg_id, ig_username)
        )
        """)
        # ensure owner is admin
        cur.execute("INSERT OR IGNORE INTO admins(tg_id) VALUES(?)", (BOT_OWNER_TELEGRAM_ID,))
        conn.commit()

def get_conn():
    thread_id = threading.get_ident()
    if thread_id not in db_connections:
        db_connections[thread_id] = sqlite3.connect(DB_PATH, check_same_thread=False)
    return db_connections[thread_id]

def close_db_connections():
    for conn in db_connections.values():
        conn.close()
    db_connections.clear()

init_db()

# ========== Crypto Helpers ==========
def ensure_user_salt(tg_id: int):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT salt FROM users WHERE tg_id=?", (tg_id,))
        row = cur.fetchone()
        if row and row[0]:
            return row[0]
        salt = os.urandom(16)
        cur.execute("INSERT OR REPLACE INTO users(tg_id,salt) VALUES(?,?)", (tg_id, salt))
        conn.commit()
        return salt

def derive_key(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=200_000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(passphrase.encode()))
    return key

def encrypt_blob(tg_id: int, passphrase: str, data: Dict[str,Any]) -> bytes:
    salt = ensure_user_salt(tg_id)
    key = derive_key(passphrase, salt)
    f = Fernet(key)
    blob = json.dumps(data).encode()
    return f.encrypt(blob)

def decrypt_blob(tg_id: int, passphrase: str, blob: bytes) -> Dict[str,Any]:
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT salt FROM users WHERE tg_id=?", (tg_id,))
        row = cur.fetchone()
        if not row:
            raise ValueError("User salt missing.")
        salt = row[0]
        key = derive_key(passphrase, salt)
        f = Fernet(key)
        raw = f.decrypt(blob)
        return json.loads(raw.decode())

# ========== Insta session helpers ==========
def session_filename_for(account_username: str, ig_id: int) -> str:
    safe = f"{account_username}_{ig_id}.session"
    return os.path.join(SESSION_DIR, safe)

def create_instaclient(sessionfile: Optional[str] = None) -> Client:
    cl = Client()

    def challenge_handler(username, choice):
        u = (username or "").lower()
        # only mark once; no telegram send from here
        if u not in PENDING_OTP:
            PENDING_OTP[u] = {
                "client": cl,
                "password": None,
                "passphrase": None,
                "needs_otp": True,
                "tg_id": None,   # we’ll fill this in later
            }
            print(f"[DEBUG] OTP required for {u} via {choice}")
        return None

    cl.challenge_code_handler = challenge_handler

    if sessionfile and os.path.exists(sessionfile):
        try:
            cl.load_settings(sessionfile)
        except Exception:
            pass

    return cl

# ========== Admin helpers ==========
def is_admin(tg_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM admins WHERE tg_id=?", (tg_id,))
        ok = cur.fetchone() is not None
        return ok

def add_admin_db(tg_id: int):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("INSERT OR IGNORE INTO admins(tg_id) VALUES(?)", (tg_id,))
        conn.commit()

def remove_admin_db(tg_id: int):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM admins WHERE tg_id=?", (tg_id,))
        conn.commit()

# ========== Preferences helpers ==========
def set_user_speed(tg_id: int, speed: float):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("INSERT OR REPLACE INTO user_prefs(tg_id, speed) VALUES(?, ?)", (tg_id, speed))
        conn.commit()

def get_user_speed(tg_id: int) -> float:
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT speed FROM user_prefs WHERE tg_id=?", (tg_id,))
        row = cur.fetchone()
        if row and row[0]:
            return float(row[0])
        return DEFAULT_MSG_SPEED

# ========== Account helpers ==========
def list_accounts_for_user(tg_id: int):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, ig_username, default_account FROM ig_accounts WHERE tg_id=?", (tg_id,))
        rows = cur.fetchall()
        return rows

def get_default_account_row(tg_id: int):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, ig_username, encrypted_blob, session_file FROM ig_accounts WHERE tg_id=? AND default_account=1", (tg_id,))
        row = cur.fetchone()
        return row

def get_passphrase_for_account(tg_id: int, ig_username: str) -> Optional[str]:
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT passphrase FROM account_passphrases WHERE tg_id=? AND ig_username=?", (tg_id, ig_username))
        row = cur.fetchone()
        return row[0] if row else None

def save_passphrase_for_account(tg_id: int, ig_username: str, passphrase: str):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("INSERT OR REPLACE INTO account_passphrases(tg_id, ig_username, passphrase) VALUES(?, ?, ?)", 
                    (tg_id, ig_username, passphrase))
        conn.commit()

def delete_passphrase_for_account(tg_id: int, ig_username: str):
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM account_passphrases WHERE tg_id=? AND ig_username=?", (tg_id, ig_username))
        conn.commit()

# ========== Unlock account and client ==========
def unlock_account_and_client(tg_id: int, passphrase: str = None) -> Client:
    # If already unlocked, return the client
    if tg_id in UNLOCKED_CLIENTS:
        return UNLOCKED_CLIENTS[tg_id]

    # If no passphrase provided, try to get it from the database
    if not passphrase:
        row = get_default_account_row(tg_id)
        if not row:
            raise ValueError("No default account set.")
        ig_username = row[1]
        passphrase = get_passphrase_for_account(tg_id, ig_username)
        if not passphrase:
            raise ValueError("⚠️ Account not unlocked yet. Please provide passphrase once via /login.")

    row = get_default_account_row(tg_id)
    if not row:
        raise ValueError("No default account set.")

    acc_id, ig_username, encrypted_blob, session_file = row[0], row[1], row[2], row[3]
    data = decrypt_blob(tg_id, passphrase, encrypted_blob)

    cl = create_instaclient(sessionfile=data.get('session_file'))
    cl.login(data['username'], data['password'])

    sf = data.get('session_file') or session_filename_for(data['username'], acc_id)
    cl.dump_settings(sf)

    # Save passphrase for future use
    save_passphrase_for_account(tg_id, ig_username, passphrase)
    
    # Cache the client
    UNLOCKED_CLIENTS[tg_id] = cl
    return cl

# ========== Authorization Decorator ==========
def authorized_only(func):
    """Decorator to check if user is authorized before executing command"""
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE, *args, **kwargs):
        tg_id = update.effective_user.id
        if not is_authorized(tg_id):
            await update.message.reply_text("❌ You are not authorized to use this bot.")
            return
        return await func(update, context, *args, **kwargs)
    return wrapper

def admin_only(func):
    """Decorator to check if user is admin before executing command"""
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE, *args, **kwargs):
        tg_id = update.effective_user.id
        if not is_admin(tg_id):
            await update.message.reply_text("❌ You are not an admin!")
            return
        return await func(update, context, *args, **kwargs)
    return wrapper

# ========== Telegram Handlers (async) ==========
async def start_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 *Welcome to Spyther's Bot!* \n\n"
        "Type /help to see available commands. ⚙️"
    )

async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg = update.effective_user.id
    base = [
        "🔐 /login - Save an Instagram account (encrypted locally)",
        "📂 /viewmyac - View saved Instagram accounts",
        "⭐ /setig <id> - Set default IG account for sending",
        "📨 /massmsg - Start interactive mass messaging (dm/gc)",
        "⏱ /msgspeed <seconds> - Set delay between messages (e.g. 0.2)",
        "🛑 /stop - Stop current sending job for your Telegram user",
        "👁️ /viewprefs - View your preferences (e.g. msg speed)",
        "🚪 /logout <ig_username> - Logout from an Instagram account"
    ]
    admin = [
        "➕ /add <telegram_chat_id> - Add admin (owner only)",
        "➖ /remove <telegram_chat_id> - Remove admin (owner only)",
        "➕ /adduser <telegram_chat_id> - Add authorized user (admin only)",
        "➖ /removeuser <telegram_chat_id> - Remove authorized user (admin only)"
    ]
    text = "📖 *Available Commands:*\n" + "\n".join(base)
    if is_admin(tg):
        text += "\n\n🔧 *Admin commands:*\n" + "\n".join(admin)
    await update.message.reply_text(text)

# Admin add/remove
@admin_only
async def add_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) < 1:
        await update.message.reply_text("Usage: /add <telegram_chat_id>")
        return
    try:
        chat_id = int(context.args[0])
        add_admin_db(chat_id)
        await update.message.reply_text(f"✅ Added admin {chat_id}")
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

@admin_only
async def remove_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) < 1:
        await update.message.reply_text("Usage: /remove <telegram_chat_id>")
        return
    try:
        chat_id = int(context.args[0])
        remove_admin_db(chat_id)
        await update.message.reply_text(f"✅ Removed admin {chat_id}")
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

# User authorization management
@admin_only
async def adduser_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) < 1:
        await update.message.reply_text("Usage: /adduser <telegram_chat_id>")
        return
    try:
        chat_id = int(context.args[0])
        add_authorized_user(chat_id)
        await update.message.reply_text(f"✅ Added authorized user {chat_id}")
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

@admin_only
async def removeuser_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if len(context.args) < 1:
        await update.message.reply_text("Usage: /removeuser <telegram_chat_id>")
        return
    try:
        chat_id = int(context.args[0])
        remove_authorized_user(chat_id)
        await update.message.reply_text(f"✅ Removed authorized user {chat_id}")
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")

@authorized_only
async def logout(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    args = context.args

    if not args:
        await update.message.reply_text("⚠️ Usage: /logout <ig_username>")
        return

    username_to_logout = args[0].strip().lower()
    
    with get_conn() as conn:
        cur = conn.cursor()
        # Check if this username exists for this Telegram user
        cur.execute("SELECT id, session_file FROM ig_accounts WHERE tg_id=? AND ig_username=?", (tg_id, username_to_logout))
        row = cur.fetchone()
        if not row:
            await update.message.reply_text(f"❌ No IG account '{username_to_logout}' found in your saved accounts.")
            return

        account_id, session_file = row[0], row[1]

        # Remove from unlocked clients (in-memory)
        if tg_id in UNLOCKED_CLIENTS:
            del UNLOCKED_CLIENTS[tg_id]

        # Remove session file if exists
        if session_file and os.path.exists(session_file):
            try:
                os.remove(session_file)
            except:
                pass

        # Remove passphrase from database
        delete_passphrase_for_account(tg_id, username_to_logout)

        # Remove account from database
        cur.execute("DELETE FROM ig_accounts WHERE id=?", (account_id,))
        conn.commit()

    await update.message.reply_text(f"✅ Instagram account '{username_to_logout}' has been logged out. You will need /login again.")

# ========== /msgspeed handler ==========
@authorized_only
async def msgspeed_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    args = context.args
    if len(args) < 1:
        await update.message.reply_text(f"⏱️ Current speed: *{get_user_speed(tg_id)}* seconds\nUsage: /msgspeed 0.4", parse_mode="Markdown")
        return
    try:
        speed = float(args[0])
        if speed <= 0:
            await update.message.reply_text("❌ Speed must be greater than 0.")
            return
    except ValueError:
        await update.message.reply_text("❌ Invalid number. Example: `/msgspeed 0.2`", parse_mode="Markdown")
        return
    set_user_speed(tg_id, speed)
    await update.message.reply_text(f"✅ Message speed updated to *{speed}* seconds.", parse_mode="Markdown")

@authorized_only
async def viewprefs_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    speed = get_user_speed(tg_id)
    await update.message.reply_text(f"⚙️ Your preferences:\n• Message speed: *{speed}* sec", parse_mode="Markdown")

# ========== Login flow (/login) ==========
# ========== /login flow ==========
async def login_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    print(f"[DEBUG] login_start by {tg_id}")   # Debug
    if not is_authorized(tg_id):
        await update.message.reply_text("❌ You are not authorized to use this bot.")
        return ConversationHandler.END
        
    await update.message.reply_text("🔐 Enter Instagram username:")
    return LOGIN_USERNAME


async def login_username(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    username = update.message.text.strip()
    print(f"[DEBUG] login_username by {tg_id}, username={username}")   # Debug

    if not is_authorized(tg_id):
        await update.message.reply_text("❌ You are not authorized to use this bot.")
        return ConversationHandler.END
        
    context.user_data['ig_login_username'] = username
    await update.message.reply_text("🔑 Enter Instagram password (it will be encrypted locally):")
    return LOGIN_PASSWORD


async def login_password(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    password = update.message.text.strip()
    print(f"[DEBUG] login_password by {tg_id}, password={password}")   # Debug

    if not is_authorized(tg_id):
        await update.message.reply_text("❌ You are not authorized to use this bot.")
        return ConversationHandler.END
        
    context.user_data['ig_login_password'] = password
    await update.message.reply_text(
        "🔒 Enter an encryption passphrase (keep this secret). You will need it to unlock the account later:"
    )
    return LOGIN_PASSPHRASE


@authorized_only
async def login_passphrase(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    passphrase = update.message.text.strip()

    ig_user = (context.user_data.get("ig_login_username") or "").strip()
    ig_pass = (context.user_data.get("ig_login_password") or "").strip()
    ig_user_key = ig_user.lower()

    print(f"[DEBUG] login_passphrase by {tg_id}, user={ig_user}, pass={ig_pass}, passphrase={passphrase}")

    if not ig_user or not ig_pass:
        await update.message.reply_text("❌ Missing username or password in session. Please /login again.")
        return ConversationHandler.END

    session_file = session_filename_for(ig_user_key, int(time.time()))

    try:
        await update.message.reply_text("⏳ Attempting Instagram login... (this may take a few seconds)")
        cl = create_instaclient()

        try:
            cl.login(ig_user, ig_pass)
        except Exception as e:
            # ✅ OTP challenge handling
            if ig_user_key in PENDING_OTP and PENDING_OTP[ig_user_key].get("needs_otp"):
                PENDING_OTP[ig_user_key].update({
                    "password": ig_pass,
                    "passphrase": passphrase,
                    "tg_id": tg_id,
                })
                await update.message.reply_text(
                    f"🔐 Instagram is asking OTP for *{ig_user}*.\n\n"
                    f"👉 Send it with: `/otp 123456`",
                    parse_mode="Markdown",
                )
                print(f"[DEBUG] OTP required for {ig_user_key}, stored in PENDING_OTP with pass+passphrase")
                return ConversationHandler.END

            # If no OTP in play → real failure
            print(f"[DEBUG] login_passphrase Exception (no challenge): {e}")
            await update.message.reply_text(f"❌ Login failed: {e}")
            return ConversationHandler.END

        # ✅ Normal login success
        cl.dump_settings(session_file)
        blob_data = {"username": ig_user, "password": ig_pass, "session_file": session_file}
        encrypted = encrypt_blob(tg_id, passphrase, blob_data)

        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO ig_accounts(tg_id, ig_username, encrypted_blob, session_file, default_account)
                VALUES(?,?,?,?,?)
                """,
                (tg_id, ig_user_key, encrypted, session_file, 0),
            )
            save_passphrase_for_account(tg_id, ig_user_key, passphrase)
            conn.commit()

        await update.message.reply_text("✅ Account saved and encrypted successfully. Use /viewmyac to see.")
        print(f"[DEBUG] Account {ig_user_key} saved for Telegram user {tg_id}")

    except Exception as e:
        print(f"[DEBUG] login_passphrase FAILED: {e}")
        await update.message.reply_text(f"❌ Instagram login failed: {e}")

    finally:
        context.user_data.pop("ig_login_username", None)
        context.user_data.pop("ig_login_password", None)

    return ConversationHandler.END


# ========== OTP Handler ==========
# ========== OTP Handler ==========
@authorized_only
async def otp_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    print(f"[DEBUG] otp_handler called by {tg_id}, args={context.args}")

    if len(context.args) != 1:
        await update.message.reply_text("Usage: /otp <6digit>")
        return

    code = context.args[0].strip()
    if not code.isdigit() or len(code) not in (6, 8):  # IG sometimes sends 6 or 8
        await update.message.reply_text("❌ Invalid OTP format. Use: /otp 123456")
        return

    # Find the pending OTP for THIS Telegram user
    target_username = None
    for username, otp_data in list(PENDING_OTP.items()):
        if otp_data.get("tg_id") == tg_id and otp_data.get("needs_otp"):
            target_username = username
            break

    if not target_username:
        await update.message.reply_text("⚠️ No OTP request pending.")
        print("[DEBUG] otp_handler: No pending OTP found.")
        return

    otp_data = PENDING_OTP[target_username]
    cl = otp_data["client"]
    ig_pass = otp_data["password"]
    passphrase = otp_data["passphrase"]

    print(f"[DEBUG] Processing OTP for {target_username}, code={code}, pass={ig_pass}, passphrase={passphrase}")

    if not ig_pass or not passphrase:
        await update.message.reply_text("⚠️ Missing password/passphrase in OTP flow. Please /login again.")
        print(f"[DEBUG] OTP aborted for {target_username}: missing pass/passphrase")
        return

    try:
        cl.challenge_resolve(code)

        session_file = session_filename_for(target_username, int(time.time()))
        cl.dump_settings(session_file)

        blob_data = {"username": target_username, "password": ig_pass, "session_file": session_file}
        encrypted = encrypt_blob(tg_id, passphrase, blob_data)

        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO ig_accounts(tg_id, ig_username, encrypted_blob, session_file, default_account)
                VALUES(?,?,?,?,?)
                """,
                (tg_id, target_username, encrypted, session_file, 0),
            )
            save_passphrase_for_account(tg_id, target_username, passphrase)
            conn.commit()

        await update.message.reply_text(f"✅ OTP accepted, logged in and saved account: {target_username}")
        print(f"[DEBUG] OTP success for {target_username}, account saved.")

        del PENDING_OTP[target_username]

    except Exception as e:
        print(f"[DEBUG] OTP failed for {target_username}: {e}")
        await update.message.reply_text(f"❌ OTP failed for {target_username}: {e}")

# ========== /viewmyac ==========
@authorized_only
async def viewmyac(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    rows = list_accounts_for_user(tg_id)
    if not rows:
        await update.message.reply_text("📂 You have no saved Instagram accounts. Use /login to add one.")
        return
    
    s = "<b>📂 Your saved Instagram accounts:</b>\n"
    for r in rows:
        s += f"{r[0]}. {r[1]} {'(default)' if r[2] else ''}\n"
    s += "\nUse <code>/setig &lt;id&gt;</code> to set default account."
    
    await update.message.reply_text(s, parse_mode="HTML")

# ========== /setig ==========
@authorized_only
async def setig(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    if len(context.args) < 1:
        await update.message.reply_text("Usage: /setig <account_id>")
        return
    try:
        acc_id = int(context.args[0])
    except Exception:
        await update.message.reply_text("Invalid id.")
        return
    
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE ig_accounts SET default_account=0 WHERE tg_id=?", (tg_id,))
        cur.execute("UPDATE ig_accounts SET default_account=1 WHERE id=? AND tg_id=?", (acc_id, tg_id))
        conn.commit()
    
    await update.message.reply_text("✅ Default account set (if id valid).")

# ========== Mass message conversation (dm & gc) ==========
@authorized_only
async def massmsg_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM ig_accounts WHERE tg_id=?", (tg_id,))
        if not cur.fetchone():
            await update.message.reply_text("⚠️ You have no saved IG accounts. Use /login to save one.")
            return ConversationHandler.END
    
    if not get_default_account_row(tg_id):
        await update.message.reply_text("⚠️ You need to set a default IG account with /setig <id> first.")
        return ConversationHandler.END

    context.user_data.update({
        'mass_choice': None,
        'mass_target': None,
        'pending_msgs': None,
        'awaiting_gc_pass': False,
        'gc_threads': [],
        'selected_thread': None
    })
    await update.message.reply_text(
        "📨 Do you want to send to *dm* or *gc*? Reply with `dm` or `gc`.",
        parse_mode="Markdown"
    )
    return CHOOSE_MODE

@authorized_only
async def massmsg_choose_mode(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip().lower()
    context.user_data['mass_choice'] = text
    tg_id = update.effective_user.id

    if text == 'dm':
        await update.message.reply_text("✉️ Enter target Instagram username (e.g. user123):")
        return ASK_DM_USERNAME

    elif text == 'gc':
        # Try to use saved passphrase first
        row = get_default_account_row(tg_id)
        if row:
            ig_username = row[1]
            passphrase = get_passphrase_for_account(tg_id, ig_username)
            if passphrase:
                try:
                    cl_inst = unlock_account_and_client(tg_id, passphrase)
                    threads = cl_inst.direct_threads(amount=LAST_N_THREADS)

                    # Include all threads with 2 or more users
                    gc_threads = [t for t in threads if len(getattr(t, "users", [])) >= 2]
                    if not gc_threads:
                        await update.message.reply_text("⚠️ No group threads found.")
                        return ConversationHandler.END

                    context.user_data['gc_threads'] = gc_threads

                    # Prepare message list
                    msg = "<b>📋 Available GCs:</b>\n"
                    for i, t in enumerate(gc_threads, start=1):
                        users = getattr(t, "users", [])
                        title = getattr(t, "title", None)
                        if not title:
                            # Show first 3 usernames if no title
                            title = ", ".join([getattr(u, "username", "?") for u in users[:3]])
                        msg += f"{i}. {title}\n"

                    await update.message.reply_text(msg, parse_mode="HTML")
                    await update.message.reply_text("🔢 Reply with the number of GC to send to:")
                    return CHOOSE_GC

                except Exception as e:
                    # If saved passphrase doesn't work, ask for it
                    pass

        await update.message.reply_text(
            "🔐 Enter your encryption passphrase to unlock the IG account for fetching GC list:"
        )
        context.user_data['awaiting_gc_pass'] = True
        return CHOOSE_GC

    else:
        await update.message.reply_text("❌ Invalid. Reply 'dm' or 'gc'.")
        return CHOOSE_MODE

@authorized_only
async def ask_dm_username(update: Update, context: ContextTypes.DEFAULT_TYPE):
    username = update.message.text.strip()
    if not username:
        await update.message.reply_text("❌ Please enter a valid Instagram username.")
        return ASK_DM_USERNAME
    # Set both mass_target and dm_target_username
    context.user_data['mass_target'] = username
    context.user_data['dm_target_username'] = username

    await update.message.reply_text(
        "📝 Now send messages as comma-separated values (e.g. hi,hello) "
        "OR upload a .txt file with comma-separated values."
    )
    return ASK_DM_MESSAGES

@authorized_only
async def massmsg_choose_gc(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id

    if context.user_data.get('awaiting_gc_pass'):
        passphrase = update.message.text.strip()
        try:
            cl_inst = unlock_account_and_client(tg_id, passphrase)
            threads = cl_inst.direct_threads(amount=LAST_N_THREADS)
        except Exception as e:
            await update.message.reply_text(f"❌ Failed: {e}")
            return ConversationHandler.END

        # Include all threads with 2 or more users
        gc_threads = [t for t in threads if len(getattr(t, "users", [])) >= 2]
        if not gc_threads:
            await update.message.reply_text("⚠️ No group threads found.")
            return ConversationHandler.END

        context.user_data['gc_threads'] = gc_threads
        context.user_data['awaiting_gc_pass'] = False

        # Prepare message list
        msg = "<b>📋 Available GCs:</b>\n"
        for i, t in enumerate(gc_threads, start=1):
            users = getattr(t, "users", [])
            title = getattr(t, "title", None)
            if not title:
                # Show first 3 usernames if no title
                title = ", ".join([getattr(u, "username", "?") for u in users[:3]])
            msg += f"{i}. {title}\n"

        await update.message.reply_text(msg, parse_mode="HTML")
        await update.message.reply_text("🔢 Reply with the number of GC to send to:")
        return CHOOSE_GC

    else:
        try:
            idx = int(update.message.text.strip()) - 1
            gc_threads = context.user_data.get('gc_threads', [])
            thread = gc_threads[idx]
            context.user_data['selected_thread'] = thread.id
        except Exception as e:
            await update.message.reply_text(f"❌ Invalid selection: {e}")
            return ConversationHandler.END

        await update.message.reply_text(
            "📝 Now send messages as comma-separated values (e.g. hi,hello) "
            "OR upload a .txt file with comma-separated values."
        )
        return ASK_GC_MESSAGES

@authorized_only
async def massmsg_collect_messages_dm(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # handles either inline messages or uploaded file for DM
    tg_id = update.effective_user.id
    if update.message.document:
        f = await update.message.document.get_file()
        local = f"tmp_{tg_id}.txt"
        await f.download_to_drive(local)
        with open(local, "r", encoding="utf-8") as fh:
            content = fh.read()
        os.remove(local)
        msgs = [m.strip() for m in content.split(",") if m.strip()]
    else:
        text = (update.message.text or "").strip()
        msgs = [m.strip() for m in text.split(",") if m.strip()]
    if not msgs:
        await update.message.reply_text("❌ No messages detected. Provide comma-separated messages or upload a .txt file.")
        return ConversationHandler.END
    context.user_data['pending_msgs'] = msgs
    
    # Try to use saved passphrase first
    row = get_default_account_row(tg_id)
    if row:
        ig_username = row[1]
        passphrase = get_passphrase_for_account(tg_id, ig_username)
        if passphrase:
            try:
                # Start sending immediately
                await start_sending_messages(update, context, passphrase)
                return ConversationHandler.END
            except Exception as e:
                # If saved passphrase doesn't work, ask for it
                pass
    
    await update.message.reply_text("🔐 Enter encryption passphrase to unlock your saved IG account for sending:")
    return ConversationHandler.END

@authorized_only
async def massmsg_collect_messages_gc(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # same as DM collect but for GC
    tg_id = update.effective_user.id
    if update.message.document:
        f = await update.message.document.get_file()
        local = f"tmp_{tg_id}.txt"
        await f.download_to_drive(local)
        with open(local, "r", encoding="utf-8") as fh:
            content = fh.read()
        os.remove(local)
        msgs = [m.strip() for m in content.split(",") if m.strip()]
    else:
        text = (update.message.text or "").strip()
        msgs = [m.strip() for m in text.split(",") if m.strip()]
    if not msgs:
        await update.message.reply_text("❌ No messages detected. Provide comma-separated messages or upload a .txt file.")
        return ConversationHandler.END
    context.user_data['pending_msgs'] = msgs
    
    # Try to use saved passphrase first
    row = get_default_account_row(tg_id)
    if row:
        ig_username = row[1]
        passphrase = get_passphrase_for_account(tg_id, ig_username)
        if passphrase:
            try:
                # Start sending immediately
                await start_sending_messages(update, context, passphrase)
                return ConversationHandler.END
            except Exception as e:
                # If saved passphrase doesn't work, ask for it
                pass
    
    await update.message.reply_text("🔐 Enter encryption passphrase to unlock your saved IG account for sending:")
    return ConversationHandler.END

@authorized_only
async def start_sending_messages(update: Update, context: ContextTypes.DEFAULT_TYPE, passphrase: str = None):
    tg_id = update.effective_user.id
    msgs = context.user_data.get('pending_msgs')
    if not msgs:
        await update.message.reply_text("❌ No messages to send.")
        return

    choice = context.user_data.get('mass_choice')

    # unlock account
    try:
        cl_inst = unlock_account_and_client(tg_id, passphrase)
    except Exception as e:
        await update.message.reply_text(f"❌ Failed to unlock account: {e}")
        return

    # Start sending in a background thread
    stop_event = threading.Event()
    stop_flags[tg_id] = stop_event
    thread = threading.Thread(
        target=send_messages_worker,
        args=(tg_id, cl_inst, msgs, choice, context.user_data.copy(), stop_event),  # copy to avoid race conditions
        daemon=True
    )
    sending_threads[tg_id] = thread
    thread.start()

    await update.message.reply_text("✅ Started sending messages. Use /stop to stop. 🚦")


# ========== Worker thread for sending messages ==========
def send_messages_worker(
    tg_id: int,
    cl_inst: Client,
    msgs: List[str],
    choice: str,
    user_data: Dict,
    stop_event: threading.Event
):
    try:
        speed = get_user_speed(tg_id)
        target = user_data.get('mass_target')
        selected_thread_id = user_data.get('selected_thread')
        dm_target_username = user_data.get('dm_target_username')

        while not stop_event.is_set():   # 🔁 keep looping until /stop
            for msg in msgs:
                if stop_event.is_set():
                    break
                try:
                    if choice == 'dm':
                        username = dm_target_username or target
                        user_id = cl_inst.user_id_from_username(username)
                        cl_inst.direct_send(msg, user_ids=[user_id])
                        print(f"[INFO] Sent DM to {username}: {msg}")
                    elif choice == 'gc' and selected_thread_id:
                        cl_inst.direct_send(msg, thread_ids=[selected_thread_id])
                        print(f"[INFO] Sent GC msg to thread {selected_thread_id}: {msg}")
                    else:
                        print(f"[WARN] Invalid choice or missing target for user {tg_id}")
                    time.sleep(speed)
                except Exception as e:
                    print(f"[ERROR] Failed to send '{msg}' for user {tg_id}: {e}")
                    time.sleep(speed)
    except Exception as e:
        print(f"[FATAL] Worker crashed for user {tg_id}: {e}")
    finally:
        # Clean up
        stop_flags.pop(tg_id, None)
        sending_threads.pop(tg_id, None)

# ========== /stop command ==========
@authorized_only
async def stop_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    tg_id = update.effective_user.id
    if tg_id in stop_flags:
        stop_flags[tg_id].set()
        del stop_flags[tg_id]
        await update.message.reply_text("🛑 Stopping...")
    else:
        await update.message.reply_text("⚠️ No active sending job to stop.")

# ========== Cancel conversation ==========
async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ Operation cancelled.")
    return ConversationHandler.END

# ========== Handle uploaded files ==========
async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # This will be handled in the conversation states
    pass

# ========== Main ==========
def main():
    app = ApplicationBuilder().token(TELEGRAM_TOKEN).build()

    # Login conversation
    login_conv = ConversationHandler(
        entry_points=[CommandHandler('login', login_start)],
        states={
            LOGIN_USERNAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, login_username)],
            LOGIN_PASSWORD: [MessageHandler(filters.TEXT & ~filters.COMMAND, login_password)],
            LOGIN_PASSPHRASE: [MessageHandler(filters.TEXT & ~filters.COMMAND, login_passphrase)],
        },
        fallbacks=[CommandHandler('cancel', cancel)],
    )

    # Mass message conversation
    massmsg_conv = ConversationHandler(
        entry_points=[CommandHandler('massmsg', massmsg_start)],
        states={
            CHOOSE_MODE: [MessageHandler(filters.TEXT & ~filters.COMMAND, massmsg_choose_mode)],
            CHOOSE_GC: [MessageHandler(filters.TEXT & ~filters.COMMAND, massmsg_choose_gc)],
            ASK_DM_USERNAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, ask_dm_username)],
            ASK_DM_MESSAGES: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, massmsg_collect_messages_dm),
                MessageHandler(filters.Document.MimeType("text/plain"), massmsg_collect_messages_dm)
            ],
            ASK_GC_MESSAGES: [
                MessageHandler(filters.TEXT & ~filters.COMMAND, massmsg_collect_messages_gc),
                MessageHandler(filters.Document.MimeType("text/plain"), massmsg_collect_messages_gc)
            ],
        },
        fallbacks=[CommandHandler('cancel', cancel)],
    )

    # Add handlers
    app.add_handler(CommandHandler("start", start_cmd))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("add", add_cmd))
    app.add_handler(CommandHandler("remove", remove_cmd))
    app.add_handler(CommandHandler("adduser", adduser_cmd))
    app.add_handler(CommandHandler("removeuser", removeuser_cmd))
    app.add_handler(CommandHandler("logout", logout))
    app.add_handler(CommandHandler("msgspeed", msgspeed_cmd))
    app.add_handler(CommandHandler("viewprefs", viewprefs_cmd))
    app.add_handler(CommandHandler("viewmyac", viewmyac))
    app.add_handler(CommandHandler("setig", setig))
    app.add_handler(CommandHandler("stop", stop_cmd))
    app.add_handler(login_conv)
    app.add_handler(massmsg_conv)
    
    app.add_handler(CommandHandler("otp", otp_handler))

    print("🤖 Bot is running...")
    app.run_polling()

if __name__ == '__main__':
    main()