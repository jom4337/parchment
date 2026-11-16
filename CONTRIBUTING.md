# Contributing

Contributions use the project license: AGPL-3.0-or-later.

Sign off each commit with `git commit -s`. The sign-off certifies the
Developer Certificate of Origin 1.1: https://developercertificate.org

A check on each pull request makes sure that every commit has a
`Signed-off-by` line with the commit author's email. If the check fails,
add the sign-off to all commits in your branch and push again:

    git rebase --signoff main
    git push --force-with-lease

Add this header to each new source file:

    SPDX-License-Identifier: AGPL-3.0-or-later
