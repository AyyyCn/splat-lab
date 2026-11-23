"""Rebuild the two game pages from src/game. Run: python3 src/game/build.py"""
import os, runpy
HERE = os.path.dirname(os.path.abspath(__file__))
for script in ("assemble.py", "ai_assemble.py"):
    runpy.run_path(os.path.join(HERE, script), run_name="__main__")
