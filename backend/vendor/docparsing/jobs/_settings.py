"""Settings for the grag package."""

import contextlib
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Literal, Self, Sequence

from pydantic import AliasChoices, Field
from pydantic_settings import (
    BaseSettings,
    CliSettingsSource,
    CliSubCommand,  # noqa F401
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)
from pydantic_settings import CliApp as _CliApp
from pydantic_settings.sources.types import (  # pyright: ignore[reportMissingImports]
    _CliSubCommand,  # pyright: ignore[reportUnknownVariableType]
)
from typing_extensions import TypeVar

T = TypeVar("T", bound="Settings")


class Settings(
    BaseSettings,
    cli_parse_args=True,
    cli_avoid_json=True,
    cli_use_class_docs_for_groups=True,
    env_nested_delimiter="__",
):
    """Base class for all settings in the graph-rag-toolbox package.

    This class is a subclass of `BaseSettings` from the `pydantic_settings` package.

    It forces the following settings:
    - `cli_parse_args` to `True`
    - `cli_avoid_json` to `True`
    - `cli_use_class_docs_for_groups` to `True`
    - `env_nested_delimiter` to `"__"`
    """

    model_config = SettingsConfigDict(extra="ignore")

    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = Field(
        default="INFO",
        validation_alias=AliasChoices("l", "log-level"),
    )


class CliApp(_CliApp):
    @staticmethod
    def run(  # pyright: ignore[reportIncompatibleMethodOverride]
        model_cls: type[T],
        cli_args: Any = None,
        cli_settings_source: CliSettingsSource[Any] | None = None,
        cli_exit_on_error: bool | None = None,
        **model_init_data: Any,
    ) -> T:
        return _CliApp.run(
            model_cls=model_cls,
            cli_args=cli_args,
            cli_settings_source=cli_settings_source,
            cli_exit_on_error=cli_exit_on_error,
            cli_cmd_method_name="cli_cmd",
            **model_init_data,
        )


DEFAULT_GRAG_YAML_FILE = "grag.yaml"
_yaml_files: ContextVar[tuple[str, ...]] = ContextVar(
    "_yaml_files", default=(DEFAULT_GRAG_YAML_FILE,)
)  # noqa E501


def get_yaml_files(settings_cls: type[BaseSettings]) -> tuple[str, ...]:
    current = list(_yaml_files.get())
    if (settings_yaml := settings_cls.model_config.get("yaml_file")) is not None:
        if not isinstance(settings_yaml, str | Path):
            current.extend(str(f) for f in settings_yaml)
        else:
            current.append(str(settings_yaml))

    if DEFAULT_GRAG_YAML_FILE not in current:
        current.append(DEFAULT_GRAG_YAML_FILE)
    return tuple(current)


class YamlSettings(Settings):
    """Yaml settings for the grag package.

    This class is a subclass of `Settings` and adds a YAML file source to the settings.

    It forces the following settings:
    - `cli_parse_args` to `True`
    - `cli_avoid_json` to `True`
    - `cli_use_class_docs_for_groups` to `True`
    - `env_nested_delimiter` to `"__"`

    At initialisation, it will build a list of YAML files to use for the settings.
    This list is built from the following sources, in order of precedence:
    1. The `yaml_files` specified in `settings_yaml_files` context manager, if any.
    2. The `yaml_file` specified in the `model_config` class attribute, if any.
    3. The default YAML file name `grag.yaml`.
    """

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (
            env_settings,
            init_settings,
            YamlConfigSettingsSource(
                settings_cls, yaml_file=get_yaml_files(settings_cls)
            ),
        )

    @classmethod
    def with_yaml_files(cls: type[Self], *yaml_files: str, **kwargs: Any) -> Self:
        """Return a new class with the specified YAML files."""
        with settings_yaml_files(yaml_files):
            return cls(**kwargs)


class SubcommandYamlSource(YamlConfigSettingsSource):
    def __init__(
        self,
        settings_cls: type[BaseSettings],
        yaml_file: Path | str | Sequence[Path | str] | None = None,
        yaml_file_encoding: str | None = None,
    ):
        self.subcommands: set[str] = set()
        for k, v in settings_cls.model_fields.items():
            if _CliSubCommand in v.metadata:
                self.subcommands.add(k)
        super().__init__(settings_cls, yaml_file, yaml_file_encoding)

    def __call__(self) -> dict[str, Any]:
        current_state = self.current_state
        subcommands = {
            k
            for k in current_state
            if k in self.subcommands and current_state[k] is not None
        }
        data = super().__call__()

        if not subcommands:
            return data

        subcommand = subcommands.pop()
        if subcommand not in data:
            data = {subcommand: data}
        return data


class SubcommandYamlSettings(Settings):
    """Yaml settings for the grag package.

    This class is a subclass of `Settings` and adds a YAML file source to the settings.

    The YAML file source is customised to handle subcommands.
    It will group the settings under the subcommand name if the subcommand is specified.

    Example
    -------
    Lets say we have the following settings class:

    ```python
    class MySettings(SubcommandYamlSettings):
        model_config = SettingsConfigDict(yaml_file="my-settings.yaml")

        subcommand1: SubcommandSettings
        subcommand2: SubcommandSettings
    ```

    Instead of having the following YAML file:

    ```yaml
    subcommand1:
        setting1: value1
        setting2: value2
        ...
    ```

    We can have the following YAML file:

    ```yaml
    setting1: value1
    setting2: value2
    ...
    ```

    As the subcommand is usually specified as a CLI argument,
    it is not necessary to have it in the YAML file.


    It forces the following settings:
    - `cli_parse_args` to `True`
    - `cli_avoid_json` to `True`
    - `cli_use_class_docs_for_groups` to `True`
    - `env_nested_delimiter` to `"__"`

    At initialisation, it will build a list of YAML files to use for the settings.
    This list is built from the following sources, in order of precedence:
    1. The `yaml_files` specified in `settings_yaml_files` context manager, if any.
    2. The `yaml_file` specified in the `model_config` class attribute, if any.
    3. The default YAML file name `grag.yaml`.
    """

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (
            env_settings,
            init_settings,
            SubcommandYamlSource(settings_cls, yaml_file=get_yaml_files(settings_cls)),
        )

    def entrypoint(self) -> None:
        _CliApp.run_subcommand(self, cli_cmd_method_name="entrypoint")

    @classmethod
    def with_yaml_files(cls: type[Self], *yaml_files: str, **kwargs: Any) -> Self:
        """Return a new class with the specified YAML files."""
        with settings_yaml_files(yaml_files):
            return cls(**kwargs)


@contextlib.contextmanager
def settings_yaml_files(
    yaml_files: str | Sequence[str],
):
    """Context manager to set the YAML files for the settings."""
    if yaml_files and isinstance(yaml_files, str):
        yaml_files = (yaml_files,)
    token = _yaml_files.set(tuple(yaml_files))
    try:
        yield
    finally:
        _yaml_files.reset(token)
