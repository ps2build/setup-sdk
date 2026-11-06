# setup-sdk

GitHub Action that prepares a runner to build a PlayStation 2 program. It downloads [ps2build](https://github.com/ps2build/ps2build), then runs `ps2build update`, which installs the toolchain, `ninja`, `tools`, `vcl` and the `sdk-core` and `sdk-world` package tiers from their own releases.

To build `sdk-core` or `sdk-world` from source, set `components` to the toolchain and tools only, so no prebuilt SDK packages are installed:

```yaml
- uses: ps2build/setup-sdk@master
  with:
    ps2dev: /opt/ps2dev
    components: toolchain,tools,ninja
```

## Usage

```yaml
- uses: ps2build/setup-sdk@master
  with:
    ps2dev: /opt/ps2dev
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `ps2dev` | required | Directory to install into |
| `version` | `latest` | ps2build release tag to bootstrap with |
| `components` | all | Comma or newline-separated component names to install, such as `toolchain,tools,ninja` |
| `force` | `false` | Reinstall components even if current |

## Outputs

| Output | Description |
|---|---|
| `version` | The ps2build release tag that was installed |

## Development

```sh
npm ci
npm run build
```

## License

[CC0 1.0](LICENSE).
