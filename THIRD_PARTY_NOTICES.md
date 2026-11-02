# Third-party notices

`dsh-autoconfig` bundles the following libraries into its built artifacts:

| Library | Version | License | Where |
|---|---|---|---|
| ssh2 | 1.17.0 | MIT | host bundle |
| zod | 4.x | MIT | host + client bundles |
| @xterm/xterm | 5.5.0 | MIT | client bundle |
| @xterm/addon-fit | 0.10.0 | MIT | client bundle |

`serialport` (13.x, MIT) and its `@serialport/*` sub-packages are loaded at
runtime from the profile's `node_modules`; they are not bundled.

Full license texts live in each package's own `LICENSE` file in the npm
installation. Copyright remains with the respective authors.
