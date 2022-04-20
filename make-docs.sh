#!/usr/bin/env bash
# Generate HTML documentation and commit to the gh-pages branch
#
## Release Steps
# update package.json with version=$ver
# npm publish --dry-run
# git tag v$ver
# ./make-docs.sh
# git push origin master gh-pages
# npm publish
#
set -e

node_modules/.bin/typedoc src/index.ts \
  --tsconfig tsconfig.build.json \
  --treatWarningsAsErrors \
  --includeVersion \
  --excludeExternals \
  --out docs

#########
# Alternative to "git subtree push --prefix"
# Commit a subdirectory to another branch while keeping the current branch clean
# Only uses plumbing commands
# Usage: grease <branch> <dir> <msg>
# Example: grease gh-pages dist v1.0.0
#########
grease() {
  local TARGET_BRANCH="refs/heads/$1"
  local TARGET_DIR="$2"
  local MESSAGE="$3"
  local parent=""
  if git show-ref --verify --quiet "$TARGET_BRANCH"; then
    parent="-p $TARGET_BRANCH"
  fi

  find "$TARGET_DIR" -type f | xargs git update-index --add
  tree_sha=$(git write-tree --prefix "$TARGET_DIR")
  find "$TARGET_DIR" -type f | xargs git update-index --force-remove
  commit_sha=$(git commit-tree -m "$MESSAGE" $parent $tree_sha)
  git update-ref $TARGET_BRANCH $commit_sha

  echo Committed "$TARGET_DIR" as "$MESSAGE" to "$TARGET_BRANCH"
  echo To undo:
  echo "  git update-ref $TARGET_BRANCH $TARGET_BRANCH~"
}

version=$(git describe --long --tags --dirty)
read -p "Commit to gh-pages as $version? Press key to continue.. " -n1 -s
grease gh-pages docs "$version"
