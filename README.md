# Bridgeway Tutors — Student Portal

A static site on GitHub Pages. No backend.

- **Students** open a private link like `https://bridgewaytutors.github.io/students-portal/s/aisha-khan-7kq2mf/` and see only their own page.
- **Admin** works at `https://bridgewaytutors.github.io/students-portal/admin/`. Nothing on the site links to it.

## How it works

The admin page saves changes by committing to this repository through the GitHub API with your token. GitHub Pages republishes the site, and the page goes live in about a minute.

```
index.html          public landing page (no student list)
404.html            shown for unknown or deleted links
admin/              admin console (needs a GitHub token to do anything)
s/<slug>/index.html the student's uploaded HTML, served as-is
s/<slug>/meta.json  student name and upload dates
```

Every link ends in a random code, so nobody can guess another student's URL.

## One-time setup

1. **Turn on Pages.** Repository → Settings → Pages → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save.
2. **Create a token.** GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new):
   - Repository access: *Only select repositories* → `students-portal`
   - Repository permissions → **Contents: Read and write**
   - Pick an expiry date. When it expires, make a new one and sign in again.
3. Open `/admin/`, paste the token and sign in.

## Using the admin page

| Task | How |
|---|---|
| Add a student | Enter a name, choose the `.html` file, click **Publish page**, then copy the link |
| Replace a page | **Replace** on the student's row. The link stays the same |
| Rename | **⋯ → Rename student** (only the admin list changes) |
| Revoke a link | **⋯ → Generate new link**. The old link stops working |
| Delete | **⋯ → Delete** |
| Preview or back up | **⋯ → Preview file** or **⋯ → Download HTML** |

## Things to know

- **The repository is public.** On a free GitHub account, Pages needs a public repo, so anyone browsing `github.com/Bridgewaytutors/students-portal` can see every uploaded file. The site doesn't link to the repo. For real privacy, upgrade to GitHub Pro and make the repo private; Pages keeps working the same way.
- **Uploads must be self-contained.** Put images inline (base64) or use full `https://` URLs. Relative links to other files won't resolve.
- **Updates take time.** Pages needs about a minute to publish, and browsers may cache the old version for up to 10 minutes. Ask students to refresh if they see old content.
- **The token is stored only in your browser.** Untick *Keep me signed in* on shared computers, and use **Sign out** when you're done.
