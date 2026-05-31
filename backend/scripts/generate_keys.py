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

new_lines = []
fernet_written = False
jwt_written = False
for line in lines:
    stripped = line.strip()
    if stripped.startswith("FERNET_KEY="):
        if existing_fernet:
            new_lines.append(line)
            fernet_written = True
            continue
        new_lines.append(f"FERNET_KEY={fernet_key}\n")
        fernet_written = True
    elif stripped.startswith("JWT_SECRET="):
        if existing_jwt:
            new_lines.append(line)
            jwt_written = True
            continue
        new_lines.append(f"JWT_SECRET={jwt_secret}\n")
        jwt_written = True
    else:
        new_lines.append(line)

if not fernet_written:
    new_lines.append(f"\nFERNET_KEY={fernet_key}\n")
if not jwt_written:
    new_lines.append(f"JWT_SECRET={jwt_secret}\n")

with open(env_path, "w") as f:
    f.writelines(new_lines)

if existing_fernet:
    print("FERNET_KEY already set — skipped")
else:
    print(f"FERNET_KEY={fernet_key}")
if existing_jwt:
    print("JWT_SECRET already set — skipped")
else:
    print(f"JWT_SECRET={jwt_secret}")
print("Done")
