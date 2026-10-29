#!/usr/bin/env python3
"""
Builds the Katančić (1831) translation into data/json/katancic/.
Delegates to scripts/build_foi_translations.py, which builds all 5 Croatian
translations from the local FOI cache (saric, katancic, rupcic, raspudic, gusic).
"""
import subprocess
import sys
import os

if __name__ == "__main__":
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build_foi_translations.py")
    sys.exit(subprocess.call([sys.executable, script, "katancic"]))
