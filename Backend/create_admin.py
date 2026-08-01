import sys
import os
from database import SessionLocal
from models import User
from auth import get_password_hash

def create_admin_user(username, password):
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.username == username).first()
        if existing:
            print(f"User '{username}' already exists. Updating role to manager...")
            existing.role = "manager"
            existing.hashed_password = get_password_hash(password)
            db.commit()
            print(f"Successfully updated '{username}' to manager role with new password.")
            return

        admin_user = User(
            username=username,
            hashed_password=get_password_hash(password),
            role="manager"
        )
        db.add(admin_user)
        db.commit()
        print(f"Successfully created admin (manager) account '{username}'!")
    except Exception as e:
        db.rollback()
        print(f"Error creating admin user: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python create_admin.py <username> <password>")
        sys.exit(1)
    
    user_arg = sys.argv[1]
    pass_arg = sys.argv[2]
    create_admin_user(user_arg, pass_arg)
