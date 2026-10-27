# AI Training Center

A complete local AI training center starter that lets you:
- create training projects
- upload or paste datasets
- fine-tune a small language model with Hugging Face
- track trained models
- chat with the newest trained model
- run entirely from a local Python server

## Features

- Project dashboard with training status
- Dataset editor with sample text uploads
- Fine-tuning pipeline using `transformers` and `torch`
- Export-ready model folders under `models/`
- Chat endpoint for interactive AI conversations
- Simple, modern UI served from the same app

## Tech stack

- FastAPI
- Uvicorn
- Transformers
- PyTorch
- Vanilla HTML/CSS/JS frontend

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Then open http://localhost:8000

## Notes

This starter is designed for a real, runnable training loop on a local machine with CPU or GPU support. For production-grade model training, you should add:
- dataset storage
- authentication
- user accounts
- GPU orchestration
- deployment hosting
- model registry and versioning

## Important

The app uses a small base model (`distilgpt2`) for a working demo. You can replace it with a larger model such as `gpt2`, `TinyLlama`, or a domain-specific model depending on your hardware.
