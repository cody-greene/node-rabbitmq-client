#!/usr/bin/env bash
# Generate HTML documentation and commit to the gh-pages branch
# View with: python -m http.server -d docs 8000
#
## Get current docs:
# git worktree add docs/ gh-pages
#
## Release Steps
# update package.json with version=$ver
# npm publish --dry-run
# git tag v$ver
# ./make-docs.sh
# git push origin master gh-pages v$ver
# npm publish
#
set -e

# typedoc.json
node -r ts-node/register/transpile-only node_modules/.bin/typedoc

lver=$(git describe --long --tags --dirty)
read -p "Commit to gh-pages as $lver? Press key to continue.. " -n1 -s
cd docs && git commit --all --message="$lver"
