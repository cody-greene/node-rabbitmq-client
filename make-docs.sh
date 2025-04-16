#!/usr/bin/env bash
# Generate HTML documentation and commit to the gh-pages branch
# View with: python -m http.server -d docs 8000
#
## Get current docs:
# git worktree add docs/ gh-pages
#
## Release Steps
# update CHANGELOG.md
# git add CHANGELOG.md
# ./release.sh <version>
# ./make-docs.sh (optional)
# git push origin master gh-pages <version>
# npm publish
#
set -e

# typedoc.json
node -r ts-node/register/transpile-only node_modules/.bin/typedoc --customCss src/overrides.css

lver=$(git describe --long --tags --dirty)
read -p "Commit to gh-pages as $lver? Press key to continue.. " -n1 -s
cd docs && git add --all && git commit --message="$lver"
