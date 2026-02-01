#!/usr/bin/env python3
"""
EdgeFlow MT5 Manager - With VPS Heartbeat
"""
import os
import sys
import json
import time
import subprocess
import requests
from datetime import datetime

# Configuration
RAILWAY_URL = "https://edgeflow-backend-production.up.railway.app"
MT5_PATH = "/root/.wine/drive_c/Program Files/MetaTrader 5/terminal64.exe"
SCRIPT_PATH = "/root/.wine/drive_c/Program Files/MetaTrader 5/MQL5/Scripts/EdgeFlow_Execute.ex5"
INSTANCES_DIR = "/opt/mt5/instances"
VPS_API_KEY = "vps-edgeflow-secure-2024-xyz"

# Global state
mt5_processes = {}
last_signal_id = None

def sync_students_from_railway():
    """Fetch active students from Railway API"""
    try:
        response = requests.get(
            f"{RAILWAY_URL}/vps/students",
            headers={"x-vps-api-key": VPS_API_KEY},
            timeout=10
        )
        
        if response.status_code == 200:
            data = response.json()
            students = data.get('students', [])
            print(f"✅ Synced {len(students)} active students from Railway")
            return students
        else:
            print(f"⚠️ Failed to sync students: HTTP {response.status_code}")
            return []
            
    except Exception as e:
        print(f"❌ Error syncing students: {e}")
        return []

def create_mt5_config(student):
    """Create MT5 config for student"""
    instance_dir = f"{INSTANCES_DIR}/{student['license_key']}"
    os.makedirs(instance_dir, exist_ok=True)
    
    config_path = f"{instance_dir}/config.ini"
    config_content = f"""[Common]
Login={student['account_number']}
Password={student['password']}
Server={student['server']}
"""
    
    with open(config_path, 'w') as f:
        f.write(config_content)
    
    return instance_dir, config_path

def launch_mt5_instance(student):
    """Launch MT5 for student account"""
    license_key = student['license_key']
    
    print(f"\n🚀 Launching MT5 for {license_key}...")
    
    instance_dir, config_path = create_mt5_config(student)
    
    cmd = [
        'xvfb-run', '-a',
        'wine', MT5_PATH,
        f'/config:{config_path}',
        '/portable'
    ]
    
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=instance_dir
        )
        
        print(f"✅ MT5 launched (PID: {process.pid})")
        return process
        
    except Exception as e:
        print(f"❌ Failed to launch MT5: {e}")
        return None

def execute_trade(student, signal):
    """Execute trade using MT5 script"""
    license_key = student['license_key']
    
    print(f"\n📊 Executing trade for {license_key}")
    print(f"   Signal: {signal['type']} {signal['symbol']} @ {signal.get('price', 'market')}")
    
    lot = signal.get('lot_size', 0.01) * student.get('lot_multiplier', 1.0)
    
    cmd = [
        'xvfb-run', '-a',
        'wine', MT5_PATH,
        f'/config:{INSTANCES_DIR}/{license_key}/config.ini',
        f'/script:EdgeFlow_Execute',
        f'/TradeType:{signal["type"]}',
        f'/TradeSymbol:{signal["symbol"]}',
        f'/TradeLot:{lot}',
        f'/TradeSL:{signal["sl"]}',
        f'/TradeTP:{signal["tp"]}'
    ]
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=f'{INSTANCES_DIR}/{license_key}'
        )
        
        print(f"   ✅ Trade execution completed")
            
    except Exception as e:
        print(f"   ❌ Error executing trade: {e}")

def check_signals(students):
    """Check for new signals"""
    global last_signal_id
    
    try:
        response = requests.get(f"{RAILWAY_URL}/signals", timeout=5)
        if response.status_code == 200:
            data = response.json()
            signals = data.get('signals', [])
            
            if signals:
                latest = signals[0]
                signal_id = latest.get('id')
                
                if signal_id and signal_id != last_signal_id:
                    last_signal_id = signal_id
                    
                    print(f"\n{'='*60}")
                    print(f"📡 NEW SIGNAL RECEIVED")
                    print(f"   Type: {latest['type']}")
                    print(f"   Symbol: {latest['symbol']}")
                    print(f"   SL: {latest['sl']} | TP: {latest['tp']}")
                    print(f"{'='*60}")
                    
                    ea_id = latest.get('ea_id')
                    for student in students:
                        if student.get('ea_id') == ea_id:
                            execute_trade(student, latest)
                    
    except Exception as e:
        pass

def manage_mt5_processes(students):
    """Launch/manage MT5 instances for active students"""
    global mt5_processes
    
    current_licenses = {s['license_key'] for s in students}
    running_licenses = set(mt5_processes.keys())
    
    # Launch new students
    for license_key in current_licenses - running_licenses:
        student = next(s for s in students if s['license_key'] == license_key)
        process = launch_mt5_instance(student)
        if process:
            mt5_processes[license_key] = {
                'student': student,
                'process': process
            }
        time.sleep(3)
    
    # Stop removed students
    for license_key in running_licenses - current_licenses:
        print(f"⏸️ Stopping MT5 for {license_key}")
        mt5_processes[license_key]['process'].terminate()
        del mt5_processes[license_key]
    
    # Check process health
    for license_key, data in list(mt5_processes.items()):
        if data['process'].poll() is not None:
            print(f"⚠️ Restarting {license_key}...")
            data['process'] = launch_mt5_instance(data['student'])

def send_heartbeat():
    """Send heartbeat for all running MT5 instances"""
    for license_key, data in mt5_processes.items():
        try:
            mt5_connected = data['process'].poll() is None
            
            requests.post(
                f"{RAILWAY_URL}/vps/heartbeat",
                headers={"x-vps-api-key": VPS_API_KEY},
                json={
                    "license_key": license_key,
                    "mt5_connected": mt5_connected
                },
                timeout=3
            )
        except:
            pass

def main():
    print("="*60)
    print("EdgeFlow MT5 Manager - VPS Heartbeat Enabled")
    print("="*60)
    
    print("\n🔄 Syncing with Railway API...")
    students = sync_students_from_railway()
    
    if not students:
        print("\n⚠️ No active students found")
        print("Students can register via mobile app")
    
    print(f"\n✅ Managing {len(students)} active students")
    print("\n📡 Monitoring for signals and sending heartbeats...")
    print("Press Ctrl+C to stop\n")
    
    manage_mt5_processes(students)
    
    sync_counter = 0
    heartbeat_counter = 0
    
    try:
        while True:
            check_signals(students)
            
            # Sync students every 30 seconds
            sync_counter += 1
            if sync_counter >= 6:
                print("\n🔄 Syncing students...")
                students = sync_students_from_railway()
                manage_mt5_processes(students)
                sync_counter = 0
            
            # Send heartbeat every 15 seconds
            heartbeat_counter += 1
            if heartbeat_counter >= 3:
                send_heartbeat()
                heartbeat_counter = 0
            
            time.sleep(5)
            
    except KeyboardInterrupt:
        print("\n\n🛑 Shutting down...")
        for data in mt5_processes.values():
            data['process'].terminate()
        print("✅ All instances stopped")

if __name__ == "__main__":
    main()


