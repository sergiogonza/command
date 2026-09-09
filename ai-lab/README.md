# CYBERMIND — AI Cognitive Operations Lab

Laboratorio local para Artix/Linux con HUD tipo command center, router AUTO/LOGIC/REASON/DUAL, telemetría del sistema, trazas, grafo ontológico y feedback.

## Estado actual

- HUD local en `127.0.0.1:7070`
- métricas Linux desde `/proc`
- router de intención
- rutas DIRECT / LOGIC / REASON / DUAL
- AI Trace
- grafo ontológico/semántico inicial
- SQLite para trazas y feedback
- modelos todavía como stubs; integración con llama.cpp será el siguiente paso

## Instalar en Artix

```bash
git clone https://github.com/sergiogonza/command.git
cd command
git switch ai-cognitive-lab
cd ai-lab
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
bash run.sh
```

Abrir `http://127.0.0.1:7070`.

## Descargar los dos modelos

No subir pesos GGUF a GitHub. La carpeta `models/` está ignorada.

```bash
cd ai-lab
source .venv/bin/activate
bash download_models.sh
```

Quedarán en:

```text
models/logic/qwen2.5-0.5b-instruct-q4_k_m.gguf
models/reason/MiniCPM5-1B-Q4_K_M.gguf
```

Modelos elegidos:

- LOGIC: `Qwen/Qwen2.5-0.5B-Instruct-GGUF`, cuantización `Q4_K_M`.
- REASON: `openbmb/MiniCPM5-1B-GGUF`, cuantización `Q4_K_M`.

## Actualizar desde Artix

```bash
cd command
git switch ai-cognitive-lab
git pull origin ai-cognitive-lab
```

Después reinicia el servidor local si hay cambios de backend.
