"""French dictionary resource module."""

import importlib.resources

LANG_TO_PATH = {
    "fr": importlib.resources.files(__package__) / "french_full.txt.gz",
    # "en": importlib.resources.files(__package__) / "english_full.txt.gz",# if more accurate than wordninja native dict
    # "de": importlib.resources.files(__package__) / "german_full.txt.gz",
    # "es": importlib.resources.files(__package__) / "spanish_full.txt.gz",
}
