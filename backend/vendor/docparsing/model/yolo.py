"""Model wrapper for YOLOv10 model for document layout parsing"""

from typing import Any
import numpy as np
from huggingface_hub import hf_hub_download
from doclayout_yolo import YOLOv10


class Yolov10Model:
    """Model wrapper for YOLOv10 model for document layout parsing

    Parameters
    ----------
    repo_id: str
        Hugging Face repository ID
    filename: str
        Filename of the pre-trained model
    threshold: float
        Confidence threshold for layout elements

    Examples
    --------
    ```python
    from docparsing.model import Yolov10Model

    # Create a Yolov10Model instance
    model = Yolov10Model()
    ```

    """

    def __init__(
        self,
        repo_id: str = "juliozhao/DocLayout-YOLO-DocStructBench",
        filename: str = "doclayout_yolo_docstructbench_imgsz1024.pt",
        threshold: float = 0.5,
    ):
        filepath = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
        )
        self.model = YOLOv10(filepath)
        self.threshold = threshold

    def predict(self, image: np.ndarray) -> list[dict[str, Any]]:
        """Predict layout elements for a given image"""

        det_res = self.model.predict(
            image,  # Image to predict
            imgsz=1024,  # Prediction image size
            conf=self.threshold,  # Confidence threshold
        )
        return det_res[0].summary(normalize=True, decimals=5)
