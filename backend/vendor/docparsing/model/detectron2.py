"""detectron2 onnx"""

import os
from typing import Final, Any
import logging
from cv2 import resize, INTER_LINEAR
import numpy as np
import onnxruntime
from huggingface_hub import hf_hub_download
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxruntime.capi._pybind_state import RuntimeException
from ..schemas import Paragraph, Text, Title, Image, List, Table, Extractor
from ..config import CONFIG

logger = logging.getLogger(__name__)


### ============ utils ===============
def download_if_needed_and_get_local_path(
    path_or_repo: str, filename: str, **kwargs: dict[str, Any]
) -> str:
    """Returns path to local file if it exists, otherwise treats it as a huggingface repo and
    attempts to download."""
    local_path = os.path.join(kwargs.get("local_dir", ""), filename)
    if os.path.exists(local_path):
        return local_path
    return hf_hub_download(path_or_repo, filename, **kwargs)


# ================ utils ===================

DEFAULT_LABEL_MAP: Final[dict[int, str]] = {
    0: "Text",
    1: "Title",
    2: "List",
    3: "Table",
    4: "Figure",
}


class DetectronONNXModel:
    """Model wrapper for detectron2 ONNX model.

    Parameters
    ----------
    label_map: dict[int, str] | None
        Mapping of class indices to class names. If None, the default label map is used.
    paragraph_threshold: float
        Confidence threshold for paragraphs.
    table_threshold: float
        Confidence threshold for tables.

    Examples
    --------
    ```python
    from docparsing.model import DetectronONNXModel

    # Create a DetectronONNXModel instance
    model = DetectronONNXModel()
    ```

    """

    LABEL2CLASS: dict[str, type[Paragraph | Table]] = {
        "Table": Table,
        "Title": Title,
        "Text": Text,
        "List": List,
        "Figure": Image,
    }

    def __init__(
        self,
        label_map: dict[int, str] | None = None,
        paragraph_threshold: float = 0.5,
        table_threshold: float = 0.5,
    ):
        # The model was trained and exported with this shape
        self.required_w = 800
        self.required_h = 1035
        model_path = CONFIG.cache_dir / "detectron2_onnx.onnx"
        if not os.path.exists(model_path):
            download_if_needed_and_get_local_path(
                "unstructuredio/detectron2_faster_rcnn_R_50_FPN_3x",
                "model.onnx",
                local_dir=CONFIG.cache_dir,
            )
            source_path = CONFIG.cache_dir / "model.onnx"
            quantize_dynamic(source_path, model_path, weight_type=QuantType.QUInt8)
        available_providers = onnxruntime.get_available_providers()
        ordered_providers = [
            "TensorrtExecutionProvider",
            "CUDAExecutionProvider",
            "CPUExecutionProvider",
        ]
        providers = [
            provider
            for provider in ordered_providers
            if provider in available_providers
        ]

        self.model = onnxruntime.InferenceSession(
            model_path,
            providers=providers,
        )
        self.model_path = model_path
        self.label_map = label_map if label_map is not None else DEFAULT_LABEL_MAP
        self.paragraph_threshold = paragraph_threshold
        self.table_threshold = table_threshold

    @property
    def label2class(self):
        """Label to Class mapping"""
        return self.__class__.LABEL2CLASS

    def preprocess(self, image: np.ndarray) -> dict[str, np.ndarray]:
        """Process input image into required format for ingestion into the Detectron2 ONNX binary.
        This involves resizing to a fixed shape and converting to a specific numpy format.
        """
        session = self.model
        # detectron2 input expected [3,1035,800]
        image = resize(
            image,
            (self.required_w, self.required_h),
            interpolation=INTER_LINEAR,
        ).astype(np.float32)
        image = image.transpose(2, 0, 1)
        ort_inputs = {session.get_inputs()[0].name: image}
        return ort_inputs

    def postprocess(
        self,
        bboxes: np.ndarray,
        labels: np.ndarray,
        confidence_scores: np.ndarray,
        input_w: float,
        input_h: float,
        page_number: int,
    ) -> list[Paragraph | Table]:
        """Process output into class. Bounding box coordinates are converted to
        original image resolution."""
        elements: list[Paragraph | Table | None] = []
        width_conversion = input_w / self.required_w
        height_conversion = input_h / self.required_h
        for (x1, y1, x2, y2), label, conf in zip(bboxes, labels, confidence_scores):
            detected_class = self.label_map[int(label)]
            if (
                detected_class in ["Text", "Title", "List", "Figure"]
                and conf >= self.paragraph_threshold
            ):
                elements.append(
                    self.label2class[detected_class].create(
                        content=[],
                        x0=x1 * width_conversion / input_w,
                        y0=y1 * height_conversion / input_h,
                        x1=x2 * width_conversion / input_w,
                        y1=y2 * height_conversion / input_h,
                        label=detected_class,
                        confidence=conf,
                        page=page_number,
                        extractor=Extractor.DETECTRON2,
                    )
                )
            elif detected_class == "Table" and conf >= self.table_threshold:
                elements.append(
                    Table.create(
                        cells=[],
                        x0=x1 * width_conversion / input_w,
                        y0=y1 * height_conversion / input_h,
                        x1=x2 * width_conversion / input_w,
                        y1=y2 * height_conversion / input_h,
                        confidence=conf,
                        page=page_number,
                        extractor=Extractor.DETECTRON2,
                    )
                )

        return list(filter(None, elements))

    def predict(self, image: np.ndarray, page_number: int) -> list[Paragraph | Table]:
        """Makes a prediction using detectron2 model."""
        prepared_input = self.preprocess(image)
        try:
            result = self.model.run(None, prepared_input)
        except RuntimeException as e:
            if "ReduceMax_1936" in str(e):
                # source https://github.com/Unstructured-IO/unstructured-inference/issues/134
                logger.error(
                    "Detectron2 ONNX ReduceMax error detected (probably blank page) on page %d: %s",
                    page_number,
                    e,
                    exc_info=True,
                )
                return []
            raise
        bboxes, labels, confidence_scores = result[:3]
        input_w, input_h = image.shape[:2]
        return self.postprocess(
            bboxes, labels, confidence_scores, input_w, input_h, page_number
        )
