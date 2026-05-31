import secrets
import os

from cryptography.fernet import Fernet

env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")

fernet_key = Fernet.generate_key().decode()
jwt_secret = secrets.token_hex(32)

lines = []
if os.path.exists(env_path):
    with open(env_path, "r") as f:
        lines = f.readlines()

existing_fernet = any(
    line.strip().startswith("FERNET_KEY=") and line.strip() != "FERNET_KEY="
    for line in lines
)
existing_jwt = any(
    line.strip().startswith("JWT_SECRET=") and line.strip() != "JWT_SECRET="
    for line in lines
)

if existing_fernet:
    print("FERNET_KEY already set — skipped")

print(f'echo "FERNET_KEY={fernet_key}" >> .env')

if existing_jwt:
    print("JWT_SECRET already set — skipped")

print(f'echo "JWT_SECRET={jwt_secret}" >> .env')
