# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's
private vulnerability reporting: on the repository, open **Security**, then
**Report a vulnerability**.

Describe the problem and how to reproduce it, with the Sillage version, the
edition (Desktop or Server) and the system it runs on.

Fixes ship in a regular release, whose notes say what was fixed once an update
is available.

## Supported versions

Only the latest release receives fixes. Desktop updates itself; Server updates
from Settings › About or by running the installer again.

## What Sillage protects, and what it does not

Sillage is meant for you and the people you trust. Agents and terminals run under
the system account that runs Sillage, with its access to files and the network:
Sillage accounts separate projects and settings, not files. Do not give an
account to someone you would not give a shell to.

Server listens on the loopback interface. Reach it through a VPN or a protected
HTTPS reverse proxy, and do not expose its port to the Internet.

The website's [Security and privacy](https://marlburrow.github.io/sillage/security.html)
page lists what stays on your machine, every request Sillage makes on its own,
and how accounts, API keys and agents are protected.
