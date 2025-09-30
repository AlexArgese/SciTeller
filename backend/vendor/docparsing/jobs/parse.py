"""Parse a document"""

import logging
import os
import sys
from argparse import ArgumentParser

from pydantic_settings import (
    CliSettingsSource,
    CliSubCommand,
    SettingsConfigDict,
)

from docparsing.jobs._settings import (
    CliApp,
    SubcommandYamlSettings,
    settings_yaml_files,
)

from .debug import DefaultDebug
from .default import DefaultParsing

logger = logging.getLogger(__name__)


class Parse(SubcommandYamlSettings, cli_parse_args=True, cli_exit_on_error=False):
    """Parse command line interface.

    Examples
    --------
    ```bash
        uv run docparse default -f tests/docs/PDF/test_pdf_6.pdf --output_format xml -o tmp
    ```

    """

    model_config = SettingsConfigDict(
        arbitrary_types_allowed=True,
        cli_implicit_flags=True,
        nested_model_default_partial_update=True,
        env_prefix="DP_",
    )

    default: CliSubCommand[DefaultParsing]
    debug: CliSubCommand[DefaultDebug]

    def _configure_logging(self) -> None:
        if os.getenv("DEBUG", "").lower() in ("1", "true"):
            self.log_level = "DEBUG"
        logging.basicConfig(
            level=self.log_level,
            format="%(asctime)s  - %(levelname)s - %(message)s",
            filemode="w",
        )

    def cli_cmd(self) -> None:
        """Run the subcommand."""
        self._configure_logging()
        CliApp.run_subcommand(self)


def _get_parser():
    parser = ArgumentParser()
    parser.add_argument(
        "--config-file",
        help="Path to the configuration file.",
        default="parse.yaml",
    )
    return parser


def main():
    """Run the default parsing job."""
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s  - %(levelname)s - %(message)s",
        stream=sys.stderr,
    )
    if "DEBUG" in os.environ:
        logging.getLogger("docparsing").setLevel(logging.DEBUG)
    else:
        logging.getLogger("docparsing").setLevel(logging.INFO)
    parser = _get_parser()
    cli_settings = CliSettingsSource[Parse](Parse, root_parser=parser)
    args = parser.parse_args()
    with settings_yaml_files(args.config_file):
        _ = CliApp.run(
            Parse,
            cli_args=args,
            cli_settings_source=cli_settings,
        )


if __name__ == "__main__":
    main()
