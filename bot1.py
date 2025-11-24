import os
import requests
import sqlite3
import asyncio
import random
import string
from datetime import datetime
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, ContextTypes, CallbackQueryHandler, MessageHandler, filters
from telegram.error import TelegramError

# ==================== CONFIGURATION ====================
BOT_TOKEN = "8477680656:AAFGh--bjf6Wuh4eGhX7Dd1GsqKC90aACQQ"
ADMIN_IDS = [5623359350, 8260463744, 1847144158, 7818314986]

# Force Join Channels
FORCE_JOIN_CHANNELS = [
    "@jerrybyte",
    "@techyspyther",
    "@PrivateMethodsGC",
    "@GiftcNFT",
    "@PrivateMeths"
]

# Credit Packages
CREDIT_PACKAGES = {
    "5": {"credits": 5, "price": 20},
    "15": {"credits": 15, "price": 50},
    "40": {"credits": 40, "price": 100},
    "100": {"credits": 100, "price": 200}
}

# Referral Settings
REFERRAL_REWARD = 1
MIN_WITHDRAW = 5

# ==================== HELPER FUNCTIONS ====================
def generate_referral_code():
    """Generate unique 8-character referral code"""
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=8))

def is_admin(user_id):
    """Check if user is admin"""
    return user_id in ADMIN_IDS

def add_admin(user_id):
    """Add new admin"""
    if user_id not in ADMIN_IDS:
        ADMIN_IDS.append(user_id)
        return True
    return False

def remove_admin(user_id):
    """Remove admin"""
    if user_id in ADMIN_IDS and len(ADMIN_IDS) > 1:
        ADMIN_IDS.remove(user_id)
        return True
    return False

# ==================== DATABASE SETUP ====================
def init_db():
    conn = sqlite3.connect('jerry_bot.db')
    c = conn.cursor()
    
    # Users table
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        credits INTEGER DEFAULT 5,
        total_searches INTEGER DEFAULT 0,
        join_date TEXT,
        referral_code TEXT UNIQUE,
        referred_by INTEGER,
        referral_count INTEGER DEFAULT 0,
        referral_earnings INTEGER DEFAULT 0
    )''')
    
    # Redeem codes table
    c.execute('''CREATE TABLE IF NOT EXISTS redeem_codes (
        code TEXT PRIMARY KEY,
        total_boxes INTEGER,
        remaining_boxes INTEGER,
        credits_per_box INTEGER,
        created_date TEXT,
        custom_name TEXT
    )''')
    
    # Redeemed history
    c.execute('''CREATE TABLE IF NOT EXISTS redeem_history (
        user_id INTEGER,
        code TEXT,
        credits INTEGER,
        redeem_date TEXT
    )''')
    
    # Withdrawal history
    c.execute('''CREATE TABLE IF NOT EXISTS withdrawal_history (
        user_id INTEGER,
        amount INTEGER,
        status TEXT,
        request_date TEXT,
        processed_date TEXT
    )''')
    
    conn.commit()
    conn.close()

init_db()

# ==================== DATABASE FUNCTIONS ====================
def get_user(user_id):
    conn = sqlite3.connect('jerry_bot.db')
    c = conn.cursor()
    c.execute('SELECT * FROM users WHERE user_id = ?', (user_id,))
    user = c.fetchone()
    conn.close()
    return user

def add_user(user_id, username, referred_by=None):
    conn = sqlite3.connect('jerry_bot.db')
    c = conn.cursor()
    try:
        referral_code = generate_referral_code()
        c.execute('''INSERT INTO users 
                    (user_id, username, credits, total_searches, join_date, referral_code, referred_by, referral_count, referral_earnings) 
                    VALUES (?, ?, 5, 0, ?, ?, ?, 0, 0)''',
                  (user_id, username, datetime.now().strftime('%Y-%m-%d %H:%M:%S'), referral_code, referred_by))
        
        if referred_by:
            c.execute('UPDATE users SET referral_count = referral_count + 1, referral_earnings = referral_earnings + ?, credits = credits + ? WHERE user_id = ?',
                     (REFERRAL_REWARD, REFERRAL_REWARD, referred_by))
        
        conn.commit()
    except sqlite3.IntegrityError:
        pass
    conn.close()

def get_user_by_referral_code(ref_code):
    conn = sqlite3.connect('jerry_bot.db')
    c = conn.cursor()
    c.execute('SELECT user_id FROM users WHERE referral_code = ?', (ref_code,))
    result = c.fetchone()
    conn.close()
    return result[0] if result else None

def update_credits(user_id, credits):
    conn = sqlite3.connect('jerry_bot.db')
    c = conn.cursor()
    c.execute('UPDATE users SET credits = credits + ? WHERE user_id = ?', (credits, user_id))
    conn.commit()
    conn.close()

def deduct_credit(user_id):
    conn = sqlite3.connect('jerry_bot.db')
    c = conn.cursor()
    c.execute('UPDATE users SET credits = credits - 1, total_searches = total_searches + 1 WHERE user_id = ?', (user_id,))
    conn.commit()
    conn.close()

def get_all_users():
    conn = sqlite3.connect('jerry_bot.db')
    c = conn.cursor()
    c.execute('SELECT * FROM users')
    users = c.fetchall()
    conn.close()
    return users

def create_redeem_code(code, total_boxes, credits_per_box, custom_name=None):
    conn = sqlite3.connect('jerry_bot.db')
    c = conn.cursor()
    c.execute('INSERT INTO redeem_codes VALUES (?, ?, ?, ?, ?, ?)',
              (code, total_boxes, total_boxes, credits_per_box, datetime.now().strftime('%Y-%m-%d %H:%M:%S'), custom_name))
    conn.commit()
    conn.close()

def redeem_code(user_id, code):
    conn = sqlite3.connect('jerry_bot.db')
    c = conn.cursor()
    
    c.execute('SELECT * FROM redeem_codes WHERE code = ?', (code,))
    redeem = c.fetchone()
    
    if not redeem:
        conn.close()
        return None, "🤔 Oopsie! That code doesn't exist! Did Jerry eat it? 🐭"
    
    if redeem[2] <= 0:
        conn.close()
        return None, "😢 Aww! This code box is empty! All the treats are gone! 🎁"
    
    c.execute('SELECT * FROM redeem_history WHERE user_id = ? AND code = ?', (user_id, code))
    if c.fetchone():
        conn.close()
        return None, "🙅‍♀️ Hey there! You already grabbed this code! Jerry says no double treats! 🐭💕"
    
    credits = redeem[3]
    c.execute('UPDATE redeem_codes SET remaining_boxes = remaining_boxes - 1 WHERE code = ?', (code,))
    c.execute('INSERT INTO redeem_history VALUES (?, ?, ?, ?)',
              (user_id, code, credits, datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
    c.execute('UPDATE users SET credits = credits + ? WHERE user_id = ?', (credits, user_id))
    conn.commit()
    conn.close()
    
    return credits, None

# ==================== API FUNCTIONS ====================
async def fetch_api_data(url):
    """Generic async API call"""
    try:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None, 
            lambda: requests.get(url, timeout=30)
        )
        return response.json()
    except Exception as e:
        return {"error": str(e)}

async def fetch_number_info(number):
    url = f"https://num-search.drsudo.workers.dev/api/search?num={number}&key=alike"
    return await fetch_api_data(url)

async def fetch_aadhaar_info(aadhaar):
    url = f"https://addartofamily.vercel.app/fetch?aadhaar={aadhaar}&key=fxt"
    return await fetch_api_data(url)

async def fetch_vehicle_info(vehicle):
    url = f"https://anmol-vehicle-info.vercel.app/vehicle_info?vehicle_no={vehicle}"
    return await fetch_api_data(url)

async def fetch_ifsc_info(ifsc):
    url = f"https://ifsc-code-eight.vercel.app/ifsc?code={ifsc}"
    return await fetch_api_data(url)

async def fetch_ip_info(ip):
    url = f"https://ip-info.hosters.club/?ip={ip}"
    return await fetch_api_data(url)

async def fetch_pincode_info(pincode):
    url = f"https://api.postalpincode.in/pincode/{pincode}"
    return await fetch_api_data(url)

async def fetch_instagram_profile(username):
    url = f"https://instagram-api-ashy.vercel.app/api/ig-profile.php?username={username}"
    return await fetch_api_data(url)

async def fetch_grok_ai(query):
    """Get response from Grok AI"""
    try:
        url = f"https://grok4.hosters.club/grok4?q={query}"
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None, 
            lambda: requests.get(url, timeout=30)
        )
        data = response.json()
        return data.get('response', 'Jerry is thinking too hard! 🤔')
    except Exception as e:
        return f"Oops! Jerry's brain got confused! 🐭💫 ({str(e)})"

# ==================== FORCE JOIN CHECK ====================
async def check_user_membership(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    
    if is_admin(user_id):
        return True
    
    not_joined = []
    for channel in FORCE_JOIN_CHANNELS:
        try:
            member = await context.bot.get_chat_member(chat_id=channel, user_id=user_id)
            if member.status not in ['member', 'administrator', 'creator']:
                not_joined.append(channel)
        except:
            not_joined.append(channel)
    
    if not_joined:
        keyboard = []
        for channel in not_joined:
            channel_link = f"https://t.me/{channel[1:]}"
            keyboard.append([InlineKeyboardButton(f"💕 Join {channel}", url=channel_link)])
        
        keyboard.append([InlineKeyboardButton("✅ I Joined! Jerry awaits!", callback_data="check_joined")])
        
        await update.effective_message.reply_text(
            "🐭 <b>Oopsie! Jerry can't let you in yet!</b> 🐭\n\n"
            "Join our cute little channels first, pretty please! 🥺✨\n\n"
            "👇 <b>Jerry's favorite channels:</b>",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode='HTML'
        )
        return False
    
    return True

# ==================== COMMAND HANDLERS ====================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    user_id = user.id
    username = user.username or "NoUsername"
    
    if not await check_user_membership(update, context):
        return
    
    referred_by = None
    if context.args and len(context.args) > 0:
        ref_code = context.args[0]
        referred_by = get_user_by_referral_code(ref_code)
    
    if not get_user(user_id):
        add_user(user_id, username, referred_by)
        if referred_by:
            try:
                await context.bot.send_message(
                    chat_id=referred_by,
                    text=f"🎉 <b>Yay! New friend!</b> 🎉\n\n"
                         f"@{username} joined using your link!\n"
                         f"Jerry gave you {REFERRAL_REWARD} credits! 🐭💎",
                    parse_mode='HTML'
                )
            except:
                pass
    
    welcome_text = f"""
🐭 <b>Hi there, {user.first_name}!</b> 🐭

╔═══════════════════════╗
║  💜 JERRY INFO BOT 💜  ║
╚═══════════════════════╝

<i>Jerry's here to help you find anything! 🔍✨</i>

━━━━━━━━━━━━━━━━━━━━━━━━
🎀 <b>What Jerry Can Find:</b>

📱 Phone Numbers
🆔 Aadhaar Details
🚗 Vehicle Info
🌐 IP Addresses
🏦 IFSC Codes
📮 PIN Codes
📸 Instagram Profiles
🤖 AI Chat (Ask Jerry anything!)

━━━━━━━━━━━━━━━━━━━━━━━━
🎁 <b>SPECIAL GIFT:</b> 5 FREE searches!
💝 <b>Share & Earn:</b> {REFERRAL_REWARD} credits per friend!

━━━━━━━━━━━━━━━━━━━━━━━━
💌 <b>Made with love by Jerry!</b> 🐭💕
"""
    
    keyboard = [
        [InlineKeyboardButton("🆘 Help", callback_data="help"),
         InlineKeyboardButton("💎 Credits", callback_data="credits")],
        [InlineKeyboardButton("🔍 Search", callback_data="search_menu"),
         InlineKeyboardButton("💝 Referral", callback_data="referral")],
        [InlineKeyboardButton("🤖 Chat with Jerry", callback_data="ai_chat")]
    ]
    
    await update.message.reply_text(
        welcome_text, 
        parse_mode='HTML',
        reply_markup=InlineKeyboardMarkup(keyboard)
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    help_text = """
╔═══════════════════════╗
║  📚 JERRY'S GUIDE 📚  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
🔍 <b>SEARCH COMMANDS:</b>

📱 /num <code>phone</code>
🆔 /aadhaar <code>aadhaar</code>
🚗 /vehicle <code>reg_no</code>
🌐 /ip <code>ip_address</code>
🏦 /ifsc <code>ifsc_code</code>
📮 /pincode <code>pin</code>
📸 /insta <code>username</code>
🤖 /ask <code>question</code> - AI Chat!

━━━━━━━━━━━━━━━━━━━━━━━━
💼 <b>YOUR ACCOUNT:</b>

💎 /credits - Check balance
🎫 /redeem <code>CODE</code>
💝 /referral - Refer & earn
💰 /withdraw - Get your earnings

━━━━━━━━━━━━━━━━━━━━━━━━
💵 <b>PRICING:</b>
5💎=₹20 | 15💎=₹50 | 40💎=₹100 | 100💎=₹200

🎁 <b>REFERRAL:</b> Earn {REFERRAL_REWARD} credits per friend!

━━━━━━━━━━━━━━━━━━━━━━━━
🐭 <b>Jerry loves helping you!</b> 💕
"""
    
    keyboard = [[InlineKeyboardButton("🔙 Back", callback_data="back_to_start")]]
    
    if update.callback_query:
        await update.callback_query.message.edit_text(help_text, parse_mode='HTML', reply_markup=InlineKeyboardMarkup(keyboard))
    else:
        await update.message.reply_text(help_text, parse_mode='HTML', reply_markup=InlineKeyboardMarkup(keyboard))

async def num_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if not user:
        await update.message.reply_text("❌ Please /start first!")
        return
    
    if len(context.args) == 0:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /num <code>phone_number</code>\n"
            "<b>Example:</b> /num 9876543210",
            parse_mode='HTML'
        )
        return
    
    if user[2] <= 0:
        await update.message.reply_text("🚨 Out of credits! 💰", parse_mode='HTML')
        return
    
    number = context.args[0]
    processing_msg = await update.message.reply_text("🔍 Jerry is searching... 🐭")
    
    data = await fetch_number_info(number)
    deduct_credit(user_id)
    user = get_user(user_id)
    
    if "error" in data or not data.get('data'):
        await processing_msg.edit_text(f"😢 No data found!\n\n<i>Remaining: {user[2]}</i>", parse_mode='HTML')
        return
    
    try:
        results = data.get('data', [])
        if not results:
            raise ValueError("No results")
        
        result = results[0]
        
        response = f"""
╔═══════════════════════╗
║  📱 PHONE INFO 📱  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
📞 <b>Number:</b> <code>{result.get('mobile', 'N/A')}</code>

👤 <b>Name:</b> {result.get('name', 'Unknown')}
👨 <b>Father:</b> {result.get('fname', result.get('father_name', 'Unknown'))}

📧 <b>Email:</b> {result.get('email', 'N/A') or 'N/A'}
📱 <b>Alt Number:</b> {result.get('alt', result.get('alt_mobile', 'N/A')) or 'N/A'}

🌐 <b>Circle:</b> {result.get('circle', 'N/A')}
🆔 <b>ID:</b> {result.get('id', 'N/A')}
🏠 <b>Address:</b> {result.get('address', 'N/A')[:100]}...

━━━━━━━━━━━━━━━━━━━━━━━━
💎 <b>Credits Left:</b> {user[2]}
🐭 <b>Jerry found it!</b> 💕
"""
        await processing_msg.edit_text(response, parse_mode='HTML')
    except Exception as e:
        await processing_msg.edit_text(f"💥 Error: {str(e)}\n\n<i>Credits: {user[2]}</i>", parse_mode='HTML')

async def aadhaar_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if not user or len(context.args) == 0:
        await update.message.reply_text("❌ <b>Usage:</b> /aadhaar <code>aadhaar_number</code>", parse_mode='HTML')
        return
    
    if user[2] <= 0:
        await update.message.reply_text("🚨 Out of credits! 💰", parse_mode='HTML')
        return
    
    aadhaar = context.args[0]
    processing_msg = await update.message.reply_text("🔍 Jerry is searching... 🐭")
    
    data = await fetch_aadhaar_info(aadhaar)
    deduct_credit(user_id)
    user = get_user(user_id)
    
    if "error" in data or not data.get('memberDetailsList'):
        await processing_msg.edit_text(f"😢 No data found!\n\n<i>Remaining: {user[2]}</i>", parse_mode='HTML')
        return
    
    try:
        members = data.get('memberDetailsList', [])
        member_list = '\n'.join([f"👤 {m.get('memberName')} - {m.get('releationship_name')}" for m in members[:5]])
        
        response = f"""
╔═══════════════════════╗
║  🆔 AADHAAR INFO 🆔  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
🏠 <b>Address:</b> {data.get('address', 'N/A')[:100]}...

🏙️ <b>District:</b> {data.get('homeDistName', 'N/A')}
🗺️ <b>State:</b> {data.get('homeStateName', 'N/A')}

👥 <b>Family Members:</b>
{member_list}

📋 <b>Scheme:</b> {data.get('schemeName', 'N/A')}
🆔 <b>RC ID:</b> {data.get('rcId', 'N/A')}

━━━━━━━━━━━━━━━━━━━━━━━━
💎 <b>Credits Left:</b> {user[2]}
🐭 <b>Jerry's got the info!</b> 💕
"""
        await processing_msg.edit_text(response, parse_mode='HTML')
    except Exception as e:
        await processing_msg.edit_text(f"💥 Error: {str(e)}\n\n<i>Credits: {user[2]}</i>", parse_mode='HTML')

async def vehicle_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if not user or len(context.args) == 0:
        await update.message.reply_text("❌ <b>Usage:</b> /vehicle <code>vehicle_number</code>", parse_mode='HTML')
        return
    
    if user[2] <= 0:
        await update.message.reply_text("🚨 Out of credits! 💰", parse_mode='HTML')
        return
    
    vehicle = context.args[0].upper()
    processing_msg = await update.message.reply_text("🚗 Jerry is tracking... 🐭")
    
    data = await fetch_vehicle_info(vehicle)
    deduct_credit(user_id)
    user = get_user(user_id)
    
    if "error" in data or not data.get('puc_info'):
        await processing_msg.edit_text(f"😢 Vehicle not found!\n\n<i>Remaining: {user[2]}</i>", parse_mode='HTML')
        return
    
    try:
        puc = data.get('puc_info', {})
        challan = data.get('challan_info', {})
        
        challan_status = "⚠️ Has Challans!" if not challan.get('error') else "✅ No Challans! Clean!"
        
        response = f"""
╔═══════════════════════╗
║  🚗 VEHICLE INFO 🚗  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
🔢 <b>Registration:</b> <code>{puc.get('rc_vehicle_no', 'N/A')}</code>
🚙 <b>Category:</b> {puc.get('rc_vch_catg', 'N/A')}
⛽ <b>Fuel:</b> {puc.get('rc_fuel_desc', 'N/A')}
📅 <b>Reg Date:</b> {puc.get('rc_registered_at', 'N/A')[:10]}

👤 <b>Owner:</b> {puc.get('rc_owner_name', 'N/A')}

🔧 <b>Chassis:</b> {puc.get('rc_chasi_no', 'N/A')}
🔩 <b>Engine:</b> {puc.get('rc_eng_no', 'N/A')}

{challan_status}

━━━━━━━━━━━━━━━━━━━━━━━━
💎 <b>Credits Left:</b> {user[2]}
🐭 <b>Jerry's on the case!</b> 💕
"""
        await processing_msg.edit_text(response, parse_mode='HTML')
    except Exception as e:
        await processing_msg.edit_text(f"💥 Error: {str(e)}\n\n<i>Credits: {user[2]}</i>", parse_mode='HTML')

async def ip_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if not user:
        await update.message.reply_text("❌ Please /start first!")
        return
    
    if len(context.args) == 0:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /ip <code>ip_address</code>\n"
            "<b>Example:</b> /ip 165.22.192.210",
            parse_mode='HTML'
        )
        return
    
    if user[2] <= 0:
        await update.message.reply_text("🚨 Out of credits! 💰", parse_mode='HTML')
        return
    
    ip = context.args[0]
    processing_msg = await update.message.reply_text("🌐 Jerry is tracking... 🐭")
    
    data = await fetch_ip_info(ip)
    deduct_credit(user_id)
    user = get_user(user_id)
    
    if "error" in data or not data.get('ipInfo'):
        await processing_msg.edit_text(f"😢 No data found!\n\n<i>Remaining: {user[2]}</i>", parse_mode='HTML')
        return
    
    try:
        ip_info = data['ipInfo']
        
        response = f"""
╔═══════════════════════╗
║  🌐 IP INFO 🌐  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
🌐 <b>IP:</b> <code>{ip_info.get('ip', 'N/A')}</code>
🌍 <b>Country:</b> {ip_info.get('country_name', 'N/A')}
🏙️ <b>City:</b> {ip_info.get('city', 'N/A')}
📍 <b>Region:</b> {ip_info.get('region', 'N/A')}
🗺️ <b>Coordinates:</b> {ip_info.get('lat', 'N/A')}, {ip_info.get('lon', 'N/A')}
🕐 <b>Timezone:</b> {ip_info.get('tz_id', 'N/A')}

━━━━━━━━━━━━━━━━━━━━━━━━
💎 <b>Credits Left:</b> {user[2]}
🐭 <b>Jerry tracked it!</b> 💕
"""
        await processing_msg.edit_text(response, parse_mode='HTML')
    except Exception as e:
        await processing_msg.edit_text(f"💥 Error: {str(e)}\n\n<i>Credits: {user[2]}</i>", parse_mode='HTML')

async def ifsc_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if not user:
        await update.message.reply_text("❌ Please /start first!")
        return
    
    if len(context.args) == 0:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /ifsc <code>IFSC_CODE</code>\n"
            "<b>Example:</b> /ifsc SBIN0016688",
            parse_mode='HTML'
        )
        return
    
    if user[2] <= 0:
        await update.message.reply_text("🚨 Out of credits! 💰", parse_mode='HTML')
        return
    
    ifsc = context.args[0].upper()
    processing_msg = await update.message.reply_text("🏦 Jerry is fetching... 🐭")
    
    data = await fetch_ifsc_info(ifsc)
    deduct_credit(user_id)
    user = get_user(user_id)
    
    if "error" in data or data.get('status') != 'success':
        await processing_msg.edit_text(f"😢 Invalid IFSC!\n\n<i>Remaining: {user[2]}</i>", parse_mode='HTML')
        return
    
    try:
        result = data.get('result', {})
        
        response = f"""
╔═══════════════════════╗
║  🏦 BANK INFO 🏦  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
🏦 <b>Bank:</b> {result.get('BANK', 'N/A')}
🏢 <b>Branch:</b> {result.get('BRANCH', 'N/A')}
📍 <b>Address:</b> {result.get('ADDRESS', 'N/A')[:100]}...
🏙️ <b>City:</b> {result.get('CITY', 'N/A')}
🗺️ <b>State:</b> {result.get('STATE', 'N/A')}
📞 <b>Contact:</b> {result.get('CONTACT', 'N/A')}

💳 <b>IFSC:</b> <code>{result.get('IFSC', 'N/A')}</code>
🔢 <b>MICR:</b> {result.get('MICR', 'N/A')}

✅ <b>RTGS:</b> {'Yes' if result.get('RTGS') else 'No'}
✅ <b>NEFT:</b> {'Yes' if result.get('NEFT') else 'No'}
✅ <b>UPI:</b> {'Yes' if result.get('UPI') else 'No'}

━━━━━━━━━━━━━━━━━━━━━━━━
💎 <b>Credits Left:</b> {user[2]}
🐭 <b>Jerry's banking knowledge!</b> 💕
"""
        await processing_msg.edit_text(response, parse_mode='HTML')
    except Exception as e:
        await processing_msg.edit_text(f"💥 Error: {str(e)}\n\n<i>Credits: {user[2]}</i>", parse_mode='HTML')

async def pincode_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if not user:
        await update.message.reply_text("❌ Please /start first!")
        return
    
    if len(context.args) == 0:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /pincode <code>PIN_CODE</code>\n"
            "<b>Example:</b> /pincode 400001",
            parse_mode='HTML'
        )
        return
    
    if user[2] <= 0:
        await update.message.reply_text("🚨 Out of credits! 💰", parse_mode='HTML')
        return
    
    pincode = context.args[0]
    processing_msg = await update.message.reply_text("📮 Jerry is searching... 🐭")
    
    data = await fetch_pincode_info(pincode)
    deduct_credit(user_id)
    user = get_user(user_id)
    
    if isinstance(data, list) and len(data) > 0 and data[0].get('Status') == 'Success':
        post_offices = data[0].get('PostOffice', [])
        if post_offices:
            po = post_offices[0]
            response = f"""
╔═══════════════════════╗
║  📮 PIN INFO 📮  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
📮 <b>PIN Code:</b> <code>{pincode}</code>
🏢 <b>Post Office:</b> {po.get('Name', 'N/A')}
🏙️ <b>District:</b> {po.get('District', 'N/A')}
🗺️ <b>State:</b> {po.get('State', 'N/A')}
🌐 <b>Region:</b> {po.get('Region', 'N/A')}
📦 <b>Delivery:</b> {po.get('DeliveryStatus', 'N/A')}
🏢 <b>Type:</b> {po.get('BranchType', 'N/A')}

ℹ️ <b>Total Post Offices:</b> {len(post_offices)}

━━━━━━━━━━━━━━━━━━━━━━━━
💎 <b>Credits Left:</b> {user[2]}
🐭 <b>Jerry delivered!</b> 💕
"""
            await processing_msg.edit_text(response, parse_mode='HTML')
        else:
            await processing_msg.edit_text(f"😢 No data found!\n\n<i>Remaining: {user[2]}</i>", parse_mode='HTML')
    else:
        await processing_msg.edit_text(f"😢 Invalid PIN!\n\n<i>Remaining: {user[2]}</i>", parse_mode='HTML')

async def insta_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if not user:
        await update.message.reply_text("❌ Please /start first!")
        return
    
    if len(context.args) == 0:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /insta <code>username</code>\n"
            "<b>Example:</b> /insta zuck",
            parse_mode='HTML'
        )
        return
    
    if user[2] <= 0:
        await update.message.reply_text("🚨 Out of credits! 💰", parse_mode='HTML')
        return
    
    username = context.args[0].replace('@', '')
    processing_msg = await update.message.reply_text("📸 Jerry is stalking... 🐭")
    
    data = await fetch_instagram_profile(username)
    deduct_credit(user_id)
    user = get_user(user_id)
    
    if "error" in data or data.get('status') != 'ok' or not data.get('profile'):
        await processing_msg.edit_text(f"😢 Profile not found!\n\n<i>Remaining: {user[2]}</i>", parse_mode='HTML')
        return
    
    try:
        profile = data.get('profile', {})
        private = "🔒 Private" if profile.get('is_private') else "🔓 Public"
        verified = "✅ Verified" if profile.get('is_verified') else "❌ Not Verified"
        
        bio = profile.get('biography', 'N/A')
        bio_text = bio[:100] + '...' if len(bio) > 100 else bio
        
        response = f"""
╔═══════════════════════╗
║  📸 INSTA INFO 📸  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
👤 <b>Username:</b> @{profile.get('username', 'N/A')}
📝 <b>Full Name:</b> {profile.get('full_name', 'N/A')}
🆔 <b>ID:</b> <code>{profile.get('id', 'N/A')}</code>

📊 <b>Status:</b> {private} | {verified}

👥 <b>Followers:</b> {profile.get('followers', 0):,}
👤 <b>Following:</b> {profile.get('following', 0):,}
📸 <b>Posts:</b> {profile.get('posts', 0):,}

📖 <b>Bio:</b> {bio_text}

📅 <b>Joined:</b> {profile.get('account_creation_year', 'N/A')}

━━━━━━━━━━━━━━━━━━━━━━━━
💎 <b>Credits Left:</b> {user[2]}
🐭 <b>Jerry's social spy!</b> 💕
"""
        await processing_msg.edit_text(response, parse_mode='HTML')
    except Exception as e:
        await processing_msg.edit_text(f"💥 Error: {str(e)}\n\n<i>Credits: {user[2]}</i>", parse_mode='HTML')

async def ask_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if not user:
        await update.message.reply_text("❌ Please /start first!")
        return
    
    if len(context.args) == 0:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /ask <code>your question</code>\n"
            "<b>Example:</b> /ask What is quantum physics?",
            parse_mode='HTML'
        )
        return
    
    if user[2] <= 0:
        await update.message.reply_text("🚨 Out of credits! 💰", parse_mode='HTML')
        return
    
    query = ' '.join(context.args)
    processing_msg = await update.message.reply_text("🤖 Jerry is thinking... 🐭")
    
    response = await fetch_grok_ai(query)
    deduct_credit(user_id)
    user = get_user(user_id)
    
    try:
        formatted_response = f"""
╔═══════════════════════╗
║  🤖 JERRY AI 🤖  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
💭 <b>Your Question:</b>
{query}

━━━━━━━━━━━━━━━━━━━━━━━━
🧠 <b>Jerry's Answer:</b>
{response}

━━━━━━━━━━━━━━━━━━━━━━━━
💎 <b>Credits Left:</b> {user[2]}
🐭 <b>Jerry hopes that helps!</b> 💕
"""
        await processing_msg.edit_text(formatted_response, parse_mode='HTML')
    except Exception as e:
        await processing_msg.edit_text(f"💥 Error: {str(e)}\n\n<i>Credits: {user[2]}</i>", parse_mode='HTML')

async def credits_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if user:
        referrals = user[7] if len(user) > 7 else 0
        earnings = user[8] if len(user) > 8 else 0
        
        credit_text = f"""
╔═══════════════════════╗
║  💳 YOUR ACCOUNT 💳  ║
╚═══════════════════════╝

👤 <b>User:</b> {update.effective_user.first_name}
🆔 <b>ID:</b> <code>{user_id}</code>

━━━━━━━━━━━━━━━━━━━━━━━━
💎 <b>Credits:</b> {user[2]}
🔍 <b>Total Searches:</b> {user[3]}
👥 <b>Referrals:</b> {referrals}
💰 <b>Referral Earnings:</b> {earnings} credits
📅 <b>Member Since:</b> {user[4][:10]}

━━━━━━━━━━━━━━━━━━━━━━━━
💵 <b>Buy Credits:</b>
  • 5 credits = ₹20
  • 15 credits = ₹50
  • 40 credits = ₹100
  • 100 credits = ₹200

📞 Contact admin to purchase!

🐭 <b>Jerry's watching your balance!</b> 💕
"""
        keyboard = [[InlineKeyboardButton("🔙 Back", callback_data="back_to_start")]]
        
        if update.callback_query:
            await update.callback_query.message.edit_text(credit_text, parse_mode='HTML', reply_markup=InlineKeyboardMarkup(keyboard))
        else:
            await update.message.reply_text(credit_text, parse_mode='HTML', reply_markup=InlineKeyboardMarkup(keyboard))

async def referral_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if not user:
        await update.message.reply_text("❌ Please /start first!")
        return
    
    try:
        bot_username = (await context.bot.get_me()).username
        referral_link = f"https://t.me/{bot_username}?start={user[5]}"
        
        ref_text = f"""
╔═══════════════════════╗
║  💝 REFERRAL 💝  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
🎁 <b>YOUR REFERRAL CODE:</b>
<code>{user[5]}</code>

🔗 <b>YOUR REFERRAL LINK:</b>
<code>{referral_link}</code>

━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>YOUR STATS:</b>

👥 <b>Total Referrals:</b> {user[7]}
💎 <b>Earned Credits:</b> {user[8]}
💰 <b>Available to Withdraw:</b> {user[8]} credits

━━━━━━━━━━━━━━━━━━━━━━━━
💡 <b>HOW IT WORKS:</b>

1️⃣ Share your referral link
2️⃣ When someone joins, you get {REFERRAL_REWARD} credits
3️⃣ Withdraw when you have {MIN_WITHDRAW}+ credits

<i>🐭 Jerry says: Share the love! 💕</i>
"""
        
        keyboard = [
            [InlineKeyboardButton("💰 Withdraw", callback_data="withdraw")],
            [InlineKeyboardButton("🔙 Back", callback_data="back_to_start")]
        ]
        
        if update.callback_query:
            await update.callback_query.message.edit_text(ref_text, parse_mode='HTML', reply_markup=InlineKeyboardMarkup(keyboard))
        else:
            await update.message.reply_text(ref_text, parse_mode='HTML', reply_markup=InlineKeyboardMarkup(keyboard))
    except Exception as e:
        error_msg = "❌ Error loading referral info. Please try /start again."
        if update.callback_query:
            await update.callback_query.message.edit_text(error_msg, parse_mode='HTML')
        else:
            await update.message.reply_text(error_msg, parse_mode='HTML')

async def withdraw_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    user = get_user(user_id)
    
    if not user:
        await update.message.reply_text("❌ Please /start first!")
        return
    
    if len(user) < 9:
        await update.message.reply_text(
            "❌ <b>Error!</b>\n\n"
            "Your account needs update. Please type /start again!",
            parse_mode='HTML'
        )
        return
    
    referral_earnings = user[8]
    
    if referral_earnings < MIN_WITHDRAW:
        msg = (
            f"❌ <b>Not enough yet!</b>\n\n"
            f"You have: {referral_earnings} credits\n"
            f"Need: {MIN_WITHDRAW} credits minimum\n\n"
            f"🐭 Keep referring friends! Jerry believes in you! 💪💕"
        )
        
        if update.callback_query:
            await update.callback_query.message.edit_text(msg, parse_mode='HTML')
        else:
            await update.message.reply_text(msg, parse_mode='HTML')
        return
    
    withdraw_text = f"""
╔═══════════════════════╗
║  💰 WITHDRAWAL 💰  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
💎 <b>Available:</b> {referral_earnings} credits

<b>Select amount to withdraw:</b>
<i>(Credits will be added to your account)</i>

🐭 <b>Jerry's ready to transfer!</b> 💕
"""
    
    keyboard = []
    amounts = [5, 10, 20, 50, 100]
    for amount in amounts:
        if amount <= referral_earnings:
            keyboard.append([InlineKeyboardButton(f"💎 Withdraw {amount} Credits", callback_data=f"withdraw_{amount}")])
    
    keyboard.append([InlineKeyboardButton(f"✨ Withdraw All ({referral_earnings})", callback_data=f"withdraw_all")])
    keyboard.append([InlineKeyboardButton("🔙 Cancel", callback_data="referral")])
    
    if update.callback_query:
        await update.callback_query.message.edit_text(withdraw_text, parse_mode='HTML', reply_markup=InlineKeyboardMarkup(keyboard))
    else:
        await update.message.reply_text(withdraw_text, parse_mode='HTML', reply_markup=InlineKeyboardMarkup(keyboard))

async def redeem_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await check_user_membership(update, context):
        return
    
    user_id = update.effective_user.id
    
    if len(context.args) == 0:
        await update.message.reply_text("❌ <b>Usage:</b> /redeem <code>CODE</code>", parse_mode='HTML')
        return
    
    code = context.args[0].upper()
    credits, error = redeem_code(user_id, code)
    
    if error:
        await update.message.reply_text(error, parse_mode='HTML')
    else:
        await update.message.reply_text(
            f"🎉 <b>YAY! SUCCESS!</b> 🎉\n\n"
            f"You got <b>{credits} credits</b>! 💎\n\n"
            f"Use /credits to check balance!\n\n"
            f"🐭 <b>Jerry's so happy for you!</b> 💕",
            parse_mode='HTML'
        )

# ==================== ADMIN COMMANDS ====================
async def addadmin_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("❌ Admin only!")
        return
    
    if len(context.args) == 0:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /addadmin <code>user_id</code>",
            parse_mode='HTML'
        )
        return
    
    try:
        new_admin_id = int(context.args[0])
        if add_admin(new_admin_id):
            await update.message.reply_text(
                f"✅ <b>New Admin Added!</b>\n\n"
                f"User ID: <code>{new_admin_id}</code>\n"
                f"🐭 Jerry welcomes the new admin! 💕",
                parse_mode='HTML'
            )
        else:
            await update.message.reply_text("❌ Already an admin!")
    except ValueError:
        await update.message.reply_text("❌ Invalid user ID!")

async def removeadmin_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("❌ Admin only!")
        return
    
    if len(context.args) == 0:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /removeadmin <code>user_id</code>",
            parse_mode='HTML'
        )
        return
    
    try:
        admin_id = int(context.args[0])
        if remove_admin(admin_id):
            await update.message.reply_text(
                f"✅ <b>Admin Removed!</b>\n\n"
                f"User ID: <code>{admin_id}</code>\n"
                f"🐭 Jerry says goodbye! 👋",
                parse_mode='HTML'
            )
        else:
            await update.message.reply_text("❌ Can't remove (not admin or last admin)!")
    except ValueError:
        await update.message.reply_text("❌ Invalid user ID!")

async def customredeem_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("❌ Admin only!")
        return
    
    if len(context.args) < 3:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /customredeem <code>boxes credits name</code>\n"
            "<b>Example:</b> /customredeem 10 5 NEWYEAR2025",
            parse_mode='HTML'
        )
        return
    
    try:
        total_boxes = int(context.args[0])
        credits_per_box = int(context.args[1])
        code = context.args[2].upper()
        
        create_redeem_code(code, total_boxes, credits_per_box, code)
        
        await update.message.reply_text(
            f"✅ <b>Custom Code Created!</b>\n\n"
            f"🎟️ <b>Code:</b> <code>{code}</code>\n"
            f"📦 <b>Boxes:</b> {total_boxes}\n"
            f"💎 <b>Per Box:</b> {credits_per_box}\n\n"
            f"<b>Redeem:</b> /redeem {code}\n"
            f"🐭 <b>Jerry's special code!</b> 💕",
            parse_mode='HTML'
        )
    except ValueError:
        await update.message.reply_text("❌ Invalid input!")

async def stats_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("❌ Admin only!")
        return
    
    users = get_all_users()
    total_users = len(users)
    total_searches = sum(user[3] for user in users)
    
    total_referrals = 0
    total_credits = 0
    active_users = 0
    
    for user in users:
        total_credits += user[2]
        if user[3] > 0:
            active_users += 1
        if len(user) > 7:
            total_referrals += user[7]
    
    stats_text = f"""
╔═══════════════════════╗
║  📊 BOT STATISTICS 📊  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
👥 <b>Total Users:</b> {total_users}
✅ <b>Active Users:</b> {active_users}
🔍 <b>Total Searches:</b> {total_searches}
💝 <b>Total Referrals:</b> {total_referrals}
💎 <b>Credits in System:</b> {total_credits}

━━━━━━━━━━━━━━━━━━━━━━━━
📊 <b>Average per User:</b>
  • Searches: {total_searches / max(total_users, 1):.2f}
  • Credits: {total_credits / max(total_users, 1):.2f}
  • Referrals: {total_referrals / max(total_users, 1):.2f}

━━━━━━━━━━━━━━━━━━━━━━━━
🐭 <b>Jerry's empire is growing!</b> 💕
"""
    
    await update.message.reply_text(stats_text, parse_mode='HTML')

async def members_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("❌ Admin only!")
        return
    
    users = get_all_users()
    members_text = f"""
╔═══════════════════════╗
║  👥 MEMBER LIST 👥  ║
╚═══════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━
<b>Total Members:</b> {len(users)}

"""
    
    for user in users[:30]:
        username = f"@{user[1]}" if user[1] != "NoUsername" else "No Username"
        referrals = user[7] if len(user) > 7 else 0
        members_text += f"• {username}\n  ID: <code>{user[0]}</code> | 💎 {user[2]} | 🔍 {user[3]} | 👥 {referrals}\n\n"
    
    if len(users) > 30:
        members_text += f"<i>... and {len(users) - 30} more members</i>\n"
    
    members_text += "━━━━━━━━━━━━━━━━━━━━━━━━\n🐭 <b>Jerry's family!</b> 💕"
    
    await update.message.reply_text(members_text, parse_mode='HTML')

async def makeredeem_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("❌ Admin only!")
        return
    
    if len(context.args) < 2:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /makeredeem <code>boxes credits</code>\n"
            "<b>Example:</b> /makeredeem 10 5",
            parse_mode='HTML'
        )
        return
    
    try:
        total_boxes = int(context.args[0])
        credits_per_box = int(context.args[1])
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=8))
        
        create_redeem_code(code, total_boxes, credits_per_box)
        
        await update.message.reply_text(
            f"✅ <b>Code Created!</b>\n\n"
            f"🎟️ <b>Code:</b> <code>{code}</code>\n"
            f"📦 <b>Boxes:</b> {total_boxes}\n"
            f"💎 <b>Per Box:</b> {credits_per_box}\n\n"
            f"<b>Redeem:</b> /redeem {code}\n\n"
            f"🐭 <b>Jerry made a code!</b> 💕",
            parse_mode='HTML'
        )
    except ValueError:
        await update.message.reply_text("❌ Invalid input!")

async def broadcast_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("❌ Admin only!")
        return
    
    if len(context.args) == 0:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /broadcast <code>message</code>",
            parse_mode='HTML'
        )
        return
    
    message = ' '.join(context.args)
    users = get_all_users()
    
    success = 0
    failed = 0
    status_msg = await update.message.reply_text("📢 Jerry is broadcasting... 🐭")
    
    for user in users:
        try:
            await context.bot.send_message(
                chat_id=user[0],
                text=f"📢 <b>JERRY'S ANNOUNCEMENT</b> 📢\n\n{message}\n\n🐭 <b>With love, Jerry!</b> 💕",
                parse_mode='HTML'
            )
            success += 1
            await asyncio.sleep(0.05)
        except:
            failed += 1
    
    await status_msg.edit_text(
        f"✅ <b>Broadcast Complete!</b>\n\n"
        f"✅ Delivered: {success}\n"
        f"❌ Failed: {failed}\n\n"
        f"🐭 <b>Jerry told everyone!</b> 💕",
        parse_mode='HTML'
    )

async def addcredits_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("❌ Admin only!")
        return
    
    if len(context.args) < 2:
        await update.message.reply_text(
            "❌ <b>Usage:</b> /addcredits <code>user_id credits</code>\n"
            "<b>Example:</b> /addcredits 123456789 10",
            parse_mode='HTML'
        )
        return
    
    try:
        target_user_id = int(context.args[0])
        credits = int(context.args[1])
        
        update_credits(target_user_id, credits)
        await update.message.reply_text(
            f"✅ <b>Credits Added!</b>\n\n"
            f"Added {credits} credits to user {target_user_id}!\n\n"
            f"🐭 <b>Jerry's generous!</b> 💕",
            parse_mode='HTML'
        )
        
        try:
            await context.bot.send_message(
                chat_id=target_user_id,
                text=f"🎉 <b>Surprise!</b> 🎉\n\n"
                     f"Admin added {credits} credits to your account! 💎\n\n"
                     f"🐭 <b>Jerry says you're special!</b> 💕",
                parse_mode='HTML'
            )
        except:
            pass
    except ValueError:
        await update.message.reply_text("❌ Invalid input!")

# ==================== CALLBACK HANDLERS ====================
async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    if query.data == "check_joined":
        user_id = update.effective_user.id
        not_joined = []
        
        for channel in FORCE_JOIN_CHANNELS:
            try:
                member = await context.bot.get_chat_member(chat_id=channel, user_id=user_id)
                if member.status not in ['member', 'administrator', 'creator']:
                    not_joined.append(channel)
            except:
                not_joined.append(channel)
        
        if not_joined:
            await query.answer("❌ You haven't joined all channels yet! 🐭", show_alert=True)
        else:
            await query.message.delete()
            if not get_user(user_id):
                add_user(user_id, update.effective_user.username or "NoUsername")
            
            keyboard = [
                [InlineKeyboardButton("🆘 Help", callback_data="help"),
                 InlineKeyboardButton("💎 Credits", callback_data="credits")],
                [InlineKeyboardButton("🔍 Search", callback_data="search_menu"),
                 InlineKeyboardButton("💝 Referral", callback_data="referral")],
                [InlineKeyboardButton("🤖 Chat with Jerry", callback_data="ai_chat")]
            ]
            
            await context.bot.send_message(
                chat_id=user_id,
                text="✅ <b>Yay! Welcome!</b> 🎉\n\n"
                     "Jerry's excited to help you! Use the buttons below:\n\n"
                     "🐭 <b>Let's have fun!</b> 💕",
                parse_mode='HTML',
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
    
    elif query.data == "help":
        await help_command(update, context)
    
    elif query.data == "credits":
        await credits_command(update, context)
    
    elif query.data == "referral":
        await referral_command(update, context)
    
    elif query.data == "withdraw":
        await withdraw_command(update, context)
    
    elif query.data == "ai_chat":
        await query.message.edit_text(
            "🤖 <b>Chat with Jerry!</b> 🐭\n\n"
            "Use: /ask <code>your question</code>\n\n"
            "<b>Examples:</b>\n"
            "• /ask What is quantum physics?\n"
            "• /ask Tell me a joke\n"
            "• /ask How to be happy?\n"
            "• /ask What is love?\n\n"
            "<i>Jerry's AI brain is ready! 💭✨</i>",
            parse_mode='HTML',
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Back", callback_data="back_to_start")]])
        )
    
    elif query.data.startswith("withdraw_"):
        user_id = update.effective_user.id
        user = get_user(user_id)
        
        if not user or len(user) < 9:
            await query.answer("❌ Error: Please type /start again!", show_alert=True)
            return
        
        if query.data == "withdraw_all":
            amount = user[8]
        else:
            try:
                amount = int(query.data.split("_")[1])
            except (ValueError, IndexError):
                await query.answer("❌ Invalid amount!", show_alert=True)
                return
        
        if amount > user[8]:
            await query.answer("❌ Insufficient balance!", show_alert=True)
            return
        
        if amount <= 0:
            await query.answer("❌ Invalid amount!", show_alert=True)
            return
        
        try:
            conn = sqlite3.connect('jerry_bot.db')
            c = conn.cursor()
            c.execute('UPDATE users SET referral_earnings = referral_earnings - ?, credits = credits + ? WHERE user_id = ?',
                     (amount, amount, user_id))
            conn.commit()
            conn.close()
            
            await query.message.edit_text(
                f"✅ <b>Withdrawal Successful!</b> ✅\n\n"
                f"💎 <b>Amount:</b> {amount} credits\n"
                f"✨ Credits added to your account!\n\n"
                f"Use /credits to check balance!\n\n"
                f"🐭 <b>Jerry transferred your earnings!</b> 💕",
                parse_mode='HTML'
            )
        except Exception as e:
            await query.message.edit_text(
                f"❌ <b>Withdrawal Failed!</b>\n\n"
                f"Error: {str(e)}\n\n"
                f"Please contact admin!\n\n"
                f"🐭 <b>Jerry's confused!</b> 😢",
                parse_mode='HTML'
            )
    
    elif query.data == "search_menu":
        search_text = """
╔═══════════════════════╗
║  🔍 SEARCH MENU 🔍  ║
╚═══════════════════════╝

<b>Select what Jerry should find:</b>

🐭 <b>Jerry's ready to search!</b> 💕
"""
        keyboard = [
            [InlineKeyboardButton("📱 Phone", callback_data="info_num"),
             InlineKeyboardButton("🆔 Aadhaar", callback_data="info_aadhaar")],
            [InlineKeyboardButton("🚗 Vehicle", callback_data="info_vehicle"),
             InlineKeyboardButton("🌐 IP", callback_data="info_ip")],
            [InlineKeyboardButton("🏦 IFSC", callback_data="info_ifsc"),
             InlineKeyboardButton("📮 PIN", callback_data="info_pin")],
            [InlineKeyboardButton("📸 Instagram", callback_data="info_insta"),
             InlineKeyboardButton("🤖 AI Chat", callback_data="info_ask")],
            [InlineKeyboardButton("🔙 Back", callback_data="back_to_start")]
        ]
        
        await query.message.edit_text(search_text, parse_mode='HTML', reply_markup=InlineKeyboardMarkup(keyboard))
    
    elif query.data.startswith("info_"):
        search_type = query.data.replace("info_", "")
        commands = {
            "num": "📱 /num <code>phone_number</code>\nExample: /num 9876543210\n\n🐭 Jerry will find phone details!",
            "aadhaar": "🆔 /aadhaar <code>aadhaar_number</code>\nExample: /aadhaar 123456789012\n\n🐭 Jerry will get family info!",
            "vehicle": "🚗 /vehicle <code>vehicle_number</code>\nExample: /vehicle UP61S6030\n\n🐭 Jerry's tracking vehicles!",
            "ip": "🌐 /ip <code>ip_address</code>\nExample: /ip 8.8.8.8\n\n🐭 Jerry will locate the IP!",
            "ifsc": "🏦 /ifsc <code>ifsc_code</code>\nExample: /ifsc SBIN0016688\n\n🐭 Jerry knows banks!",
            "pin": "📮 /pincode <code>pincode</code>\nExample: /pincode 400001\n\n🐭 Jerry's postal detective!",
            "insta": "📸 /insta <code>username</code>\nExample: /insta instagram\n\n🐭 Jerry's social spy!",
            "ask": "🤖 /ask <code>question</code>\nExample: /ask What is love?\n\n🐭 Jerry's AI brain!"
        }
        
        keyboard = [[InlineKeyboardButton("🔙 Back", callback_data="search_menu")]]
        await query.message.edit_text(
            commands.get(search_type, "❌ Invalid"),
            parse_mode='HTML',
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
    
    elif query.data == "back_to_start":
        user = get_user(update.effective_user.id)
        if user:
            referrals = user[7] if len(user) > 7 else 0
            
            keyboard = [
                [InlineKeyboardButton("🆘 Help", callback_data="help"),
                 InlineKeyboardButton("💎 Credits", callback_data="credits")],
                [InlineKeyboardButton("🔍 Search", callback_data="search_menu"),
                 InlineKeyboardButton("💝 Referral", callback_data="referral")],
                [InlineKeyboardButton("🤖 Chat with Jerry", callback_data="ai_chat")]
            ]
            
            await query.message.edit_text(
                f"🎉 <b>Welcome Back!</b> 🎉\n\n"
                f"💎 <b>Credits:</b> {user[2]}\n"
                f"🔍 <b>Searches:</b> {user[3]}\n"
                f"👥 <b>Referrals:</b> {referrals}\n\n"
                f"🐭 <b>Jerry missed you!</b> 💕",
                parse_mode='HTML',
                reply_markup=InlineKeyboardMarkup(keyboard)
            )

# ==================== MAIN ====================
def main():
    print("🐭 Starting Jerry Info Bot...")
    print("━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"👥 Admin IDs: {ADMIN_IDS}")
    print(f"📢 Force Join Channels: {len(FORCE_JOIN_CHANNELS)}")
    print(f"🎁 Referral Reward: {REFERRAL_REWARD} credits")
    print("━━━━━━━━━━━━━━━━━━━━━━━━")
    
    application = (
        Application.builder()
        .token(BOT_TOKEN)
        .connect_timeout(30.0)
        .read_timeout(30.0)
        .write_timeout(30.0)
        .pool_timeout(30.0)
        .get_updates_connect_timeout(30.0)
        .get_updates_read_timeout(30.0)
        .build()
    )
    
    # User commands
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("credits", credits_command))
    application.add_handler(CommandHandler("referral", referral_command))
    application.add_handler(CommandHandler("withdraw", withdraw_command))
    application.add_handler(CommandHandler("redeem", redeem_command))
    
    # Search commands
    application.add_handler(CommandHandler("num", num_command))
    application.add_handler(CommandHandler("aadhaar", aadhaar_command))
    application.add_handler(CommandHandler("vehicle", vehicle_command))
    application.add_handler(CommandHandler("ip", ip_command))
    application.add_handler(CommandHandler("ifsc", ifsc_command))
    application.add_handler(CommandHandler("pincode", pincode_command))
    application.add_handler(CommandHandler("insta", insta_command))
    application.add_handler(CommandHandler("ask", ask_command))
    
    # Admin commands
    application.add_handler(CommandHandler("stats", stats_command))
    application.add_handler(CommandHandler("members", members_command))
    application.add_handler(CommandHandler("makeredeem", makeredeem_command))
    application.add_handler(CommandHandler("customredeem", customredeem_command))
    application.add_handler(CommandHandler("broadcast", broadcast_command))
    application.add_handler(CommandHandler("addcredits", addcredits_command))
    application.add_handler(CommandHandler("addadmin", addadmin_command))
    application.add_handler(CommandHandler("removeadmin", removeadmin_command))
    
    # Callback handlers
    application.add_handler(CallbackQueryHandler(button_callback))
    
    print("✅ Jerry is running!")
    print("🐭 Press Ctrl+C to stop")
    print("━━━━━━━━━━━━━━━━━━━━━━━━")
    
    application.run_polling(drop_pending_updates=True, allowed_updates=Update.ALL_TYPES)

if __name__ == '__main__':
    main()