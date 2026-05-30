import os
import email.message
from loguru import logger


async def send_verification_email(to_email: str, code: str) -> bool:
    smtp_host = os.environ.get("SMTP_HOST", "").strip()
    if not smtp_host:
        logger.warning(
            "SMTP not configured — verification code for {} is: {}",
            to_email, code,
        )
        return False

    smtp_port = int(os.environ.get("SMTP_PORT", "587"))
    smtp_user = os.environ.get("SMTP_USER", "")
    smtp_pass = os.environ.get("SMTP_PASS", "")
    smtp_from = os.environ.get("SMTP_FROM", smtp_user)

    msg = email.message.EmailMessage()
    msg["Subject"] = "Molly — Verify Your Email"
    msg["From"] = smtp_from
    msg["To"] = to_email
    msg.set_content(
        f"Your verification code is: {code}\n\n"
        f"Enter this code in the app to verify your email address.\n"
        f"This code expires in 10 minutes.\n"
    )

    try:
        import aiosmtplib
        await aiosmtplib.send(
            msg,
            hostname=smtp_host,
            port=smtp_port,
            username=smtp_user or None,
            password=smtp_pass or None,
            start_tls=True,
        )
        logger.info("Verification email sent to {}", to_email)
        return True
    except Exception as e:
        logger.error("Failed to send verification email: {}", e)
        return False
