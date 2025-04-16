#!/usr/bin/env bash

set -e

VERSION_TAG="$1"

sed -i -r "s/(\"version\":.*\")(.*)(\")/\1$VERSION_TAG\3/" package.json
sed -i -r "s/^(  version: ')(.*)(',)/\1$VERSION_TAG\3/" src/Connection.ts
git add package.json src/Connection.ts
git commit -m "release $VERSION_TAG"
git tag v$VERSION_TAG
