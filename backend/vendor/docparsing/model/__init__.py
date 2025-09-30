"""Model package for docparsing."""

from .detectron2 import DetectronONNXModel
from .tatr import TatrModel
from .doctr import DoctrModel
from .yolo import Yolov10Model
from .gemini import GeminiModel

__all__ = [
    "DetectronONNXModel",
    "TatrModel",
    "DoctrModel",
    "Yolov10Model",
    "GeminiModel",
]
