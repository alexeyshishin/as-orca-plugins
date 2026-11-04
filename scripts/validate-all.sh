#!/bin/sh
set -e
cd "$(dirname "$0")/.."
for dir in plugins/*/; do orca plugin validate "$dir"; done
orca plugin validate .
