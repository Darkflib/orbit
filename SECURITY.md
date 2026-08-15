# Security Policy

## Reporting a vulnerability

Orbit is a static, frontend-only application: it has no backend, no accounts,
and no server-side data. The most likely security-relevant issues are things
like a dependency (three.js / satellite.js) advisory, or a way for fetched TLE
text to be mishandled in the DOM.

If you believe you've found a security issue, please **do not open a public
issue**. Instead, email **darkflib@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce, and
- any relevant browser/version details.

You can expect an acknowledgement within a reasonable time frame, and we'll
work with you on a fix and coordinated disclosure.

## Supported versions

This project is developed on the `main` branch. Fixes are applied to `main`;
there are no separately maintained release branches.

## Data and privacy

Orbit fetches public orbital element data (OMM records originating with
[CelesTrak](https://celestrak.org/)) from the `orbit-data.mikepreston.org`
static mirror and caches it in `localStorage`. That mirror is the only origin
element data is requested from; the browser does not contact CelesTrak. No user
data is collected, transmitted, or stored anywhere else.
