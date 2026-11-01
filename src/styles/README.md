# Stylesheet modules

The runtime stylesheet is generated from these ordered fragments:

1. `00-tokens.css` — color, type, spacing, motion and component tokens.
2. `10-base.css` — application shell and shared components.
3. `20-pages.css` — primary page families and page-local breakpoints.
4. `30-rules-workspace.css` — rules, connections and workspace views.
5. `40-dashboard.css` — dashboard control-center additions.
6. `50-theme-vantage.css` — Vantage adapter.
7. `60-feature-pages.css` — trace, subscriptions and traffic views.
8. `70-theme-argon.css` — Argon compatibility.
9. `80-responsive.css` — final cross-page responsive corrections.

Edit these files, then run:

```sh
python3 tools/build_css.py
```

Use `python3 tools/build_css.py --check` to verify that the minified CSS,
gzip asset and content hash are current. Page-specific media queries remain
beside their owning components to preserve the original cascade.
