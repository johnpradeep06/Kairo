import os
import json
from datetime import datetime
import threading

LOG_FILE = os.getenv("ACTIVITY_LOG_PATH", os.path.join(os.path.dirname(__file__), "activity_logs.json"))
log_lock = threading.Lock()

def log_activity(username: str, action: str, target: str = None):
    """
    Thread-safe activity logger that appends records to a JSON file.
    """
    with log_lock:
        record = {
            "username": username,
            "action": action,
            "target": target,
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }
        logs = []
        if os.path.exists(LOG_FILE):
            try:
                with open(LOG_FILE, "r", encoding="utf-8") as f:
                    logs = json.load(f)
            except Exception:
                logs = []
        
        logs.append(record)
        
        try:
            with open(LOG_FILE, "w", encoding="utf-8") as f:
                json.dump(logs, f, indent=4)
        except Exception as e:
            print(f"Error saving activity log: {e}")

def get_activity_logs():
    """
    Retrieve all activity logs sorted from newest to oldest.
    """
    if not os.path.exists(LOG_FILE):
        return []
    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            logs = json.load(f)
            # Sort by timestamp descending
            logs.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
            return logs
    except Exception:
        return []
