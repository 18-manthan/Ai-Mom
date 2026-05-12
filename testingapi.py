# test_openai_key.py

import os
from openai import OpenAI

api_key = os.getenv("OPENAI_API_KEY")

if not api_key:
    print("OPENAI_API_KEY is not set")
    exit(1)

try:
    client = OpenAI(api_key=api_key)

    response = client.chat.completions.create(
        model="gpt-4.1-mini",
        messages=[
            {"role": "user", "content": "Say hello"}
        ]
    )

    print("API Key is working")
    print("Response:", response.choices[0].message.content)

except Exception as e:
    print("Error:", str(e))