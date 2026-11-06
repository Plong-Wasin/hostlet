# Hostlet

A small web app that publishes an application through an existing Cloudflare Tunnel without opening the Cloudflare Dashboard.

## Language

**Subdomain**:
The single DNS label a user types, such as `app`. Exactly one level, lowercase `[a-z0-9-]`, never `*`.
_Avoid_: Prefix, host, name

**Hostname**:
The full name formed from a Subdomain and the configured domain, such as `app.example.com`.
_Avoid_: Domain, URL, FQDN

**Ingress Rule**:
The entry in the Tunnel configuration that routes one Hostname to the configured service URL.
_Avoid_: Route, mapping, public hostname

**DNS Record**:
The proxied CNAME in the zone that points a Hostname at the Tunnel.
_Avoid_: CNAME entry, DNS entry

**Published Application**:
The pair of Ingress Rule and DNS Record that together make one Hostname reachable.
_Avoid_: Site, app, host

**Partial Failure**:
A Create that left a Published Application with only one of its two parts.
_Avoid_: Half-created, incomplete
