"""Doctr model"""

from typing import Any, Sequence
import numpy as np

from onnxtr.models import ocr_predictor as op
from onnxtr.models import from_hub


class DoctrModel:
    """Doctr Model

    Parameters
    det_arch: str
    ----------
        Detection model architecture.
    reco_arch: str
    ----------
        Recognition model architecture.

    Examples
    --------
    ```python
    from docparsing.model import DoctrModel

    # Create a DoctrModel instance
    model = DoctrModel()
    ```

    """

    def __init__(
        self,
        det_arch: str = "Felix92/onnxtr-db-resnet50",
        reco_arch: str = "Felix92/onnxtr-crnn-vgg16-bn",
        resolve_blocks: bool = True,
        load_in_8_bit: bool = True,
        **ocr_kwargs: dict[str, Any],
    ):
        ocr_kwargs["det_arch"] = from_hub(det_arch)
        ocr_kwargs["reco_arch"] = from_hub(reco_arch)
        self.model = op(
            load_in_8_bit=load_in_8_bit,
            resolve_blocks=resolve_blocks,
            **ocr_kwargs,
        )

    def predict(self, images: Sequence[np.ndarray]) -> dict[str, Any]:
        """Predict OCR"""
        predict = self.model(images)
        extract = predict.export()
        return extract
