#!/usr/bin/env bash
# Builds ConsoleLink-<version>.jar. Needs Java 21+ and Maven. Run it where you can reach repo.papermc.io (your server is fine).
# Usage: ./build.sh [paper-api-version]    e.g. ./build.sh 1.21.4-R0.1-SNAPSHOT
set -euo pipefail
cd "$(dirname "$0")"
command -v javac >/dev/null || { echo "Need a JDK (javac). On Oracle Linux: sudo dnf install -y java-21-openjdk-devel"; exit 1; }
command -v mvn >/dev/null || { echo "Need Maven. On Oracle Linux: sudo dnf install -y maven"; exit 1; }
mvn -q -B ${1:+-Dpaper.api="$1"} package
echo; ls -1 target/ConsoleLink-*.jar
echo "Copy that jar into your server's plugins/ folder and restart."
