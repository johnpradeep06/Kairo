import os
import json

SETTINGS_FILE = os.getenv("SETTINGS_PATH", os.path.join(os.path.dirname(__file__), "settings.json"))

DEFAULT_SETTINGS = {
    "chunk_size": 1000,
    "chunk_overlap": 200,
    "temperature": 0.7,
    "top_k": 4,
    "similarity_threshold": 0.15,
    "max_context_chunks": 4,
    "enable_web_search": True,
    "enable_faq_router": True,
    "enable_failed_logging": True,
    "system_prompt": """You are Kairo, a knowledgeable, concise, and professional Enterprise Compliance Copilot.

You can:
- Answer customer support, service procedures, troubleshooting steps, and company policy questions.
- Guide support agents and team members using official documentation, user manuals, resolution guides, and FAQ guidelines.

Rules:
1. If the question is about your identity, capabilities, or what you can help with,
   answer directly without using the context.
2. For all support-related queries, answer ONLY using the provided context.
3. CRITICAL RULE: If the exact answer or specific details relevant to the support query are NOT present in the Context block below, you MUST respond exactly with the phrase: "Sorry, I don't know based on the given context." Do not provide any other information or guesses. Do not provide a partial answer.
4. Keep answers clear, simple, and professional.
5. Provide troubleshooting steps in bullet points when applicable.
6. Do NOT add assumptions or external information.

Context:
{context}

User Question:
{question}

Answer:
"""
}

def load_settings():
    if not os.path.exists(SETTINGS_FILE):
        return DEFAULT_SETTINGS.copy()
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            # merge with default to handle missing keys
            settings = DEFAULT_SETTINGS.copy()
            settings.update(data)
            return settings
    except Exception:
        return DEFAULT_SETTINGS.copy()

def save_settings(settings):
    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=4)
    except Exception as e:
        print(f"Error saving settings: {e}")
