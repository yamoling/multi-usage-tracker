#! /bin/bash

bash build.sh
gnome-extensions install --force dist/multi-usage-tracker@yamoling.shell-extension.zip
