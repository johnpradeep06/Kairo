import os
import secrets
from datetime import datetime, timedelta
from dotenv import load_dotenv

# auth is imported before rag_pipeline, so it cannot rely on that module having
# loaded the .env already.
load_dotenv()
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session
from database import SessionLocal, User, get_db

# Configuration
# A shipped default secret means anyone can forge a manager token, so refuse to
# start with one. Set SECRET_KEY in .env; ALLOW_EPHEMERAL_SECRET=1 generates a
# throwaway key for local dev (every restart invalidates existing tokens).
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    if os.getenv("ALLOW_EPHEMERAL_SECRET") == "1":
        SECRET_KEY = secrets.token_urlsafe(48)
        print("[auth] WARNING: using an ephemeral SECRET_KEY — tokens die on restart.")
    else:
        raise RuntimeError(
            "SECRET_KEY is not set. Add it to your .env "
            "(generate one with: python -c \"import secrets; print(secrets.token_urlsafe(48))\"), "
            "or set ALLOW_EPHEMERAL_SECRET=1 for local development."
        )

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "120"))

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password):
    password_bytes = password.encode("utf-8")
    return pwd_context.hash(password_bytes[:72])

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
    
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise credentials_exception
    return user

async def get_current_admin_user(current_user: User = Depends(get_current_user)):
    if current_user.role != "manager":
        raise HTTPException(status_code=403, detail="Not authorized")
    return current_user
