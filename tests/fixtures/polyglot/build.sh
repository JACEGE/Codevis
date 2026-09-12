#!/usr/bin/env bash
source ./lib.sh

function build_app() {
  ./deploy.sh
  echo ok | grep o
}

build_app
