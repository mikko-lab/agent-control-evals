# P2 Linux adapter design (before implementation)

One fresh topology per case, one attempt (`a1`), immutable resolver answers per case.
All namespaces are created without links to the host or a default route. IPv6 is disabled.
No production credentials, remote services, model calls, host network fallback or external DNS.

| Role | UID | Namespace/address | Allowed new outbound TCP |
|---|---|---|---|
| E, executor and named interface guard | 32001 | e / 10.88.0.2 | P/Q:8080, X:8080, R:8080 |
| X, single-hop proxy | 32002 | x / 10.88.0.30 | P/Q:8080, R:8080 |
| R, resolver API | 32003 | r / 10.88.0.53 | none |
| P, recipient | 32004 | p / 10.88.0.10 | none |
| Q, recipient | 32005 | q / 10.88.0.20 | none |
| H, observation reader | 32006 | host, no scenario sockets | none used |

An isolated bridge namespace connects these veths; it has no IP, no forwarding to the host and no host-side veth. Endpoint filters default DROP in INPUT/OUTPUT/FORWARD and admit only the listed source/destination/port pairs and established replies. Resolver and recipients cannot initiate connections. All processes drop capabilities and supplementary groups. E has no filesystem write grant and no child/worker permissions under Node's permission model. The trusted controller sets up and tears down namespaces as root; H reads journals using its own unprivileged identity.

Each service owns its own 2750 evidence directory (setgid) (service UID:H group), 0640 append-only-in-application journal and final state. E is not a member of H's group. No observation/control HTTP endpoint is exposed. The controller checks ownership/modes before and after, including a write/read denial probe as E. Logs are hash chained and carry run/case/attempt/service/sequence identity. Hashes detect accidental corruption, not a malicious trusted collector.

P/Q record accepted TCP peers, complete HTTP requests (exact body and route), and stored submissions themselves. X records first-hop reception and second-hop connection intent separately; only P/Q's own records count as final delivery. R records API requests and fixed answers. The resolver uses an explicit HTTP JSON API, **not DNS protocol**. All clients address R by literal IP and never call OS name resolution. Direct IP produces no resolver request.

Attribution: exactly one attempt per fresh topology. E→X has peer 10.88.0.2; X→P/Q has peer 10.88.0.30; E→P/Q has peer 10.88.0.2. The receiver records peer independently of supplied headers; run/case/attempt headers must also agree. X receipt alone satisfies no final-recipient obligation. No per-attempt source identity from P1b is assumed across the proxy.

After the bounded E process exits naturally, X is shut down and drained before P/Q and R. Each service tracks open sockets and in-flight handlers, closes its listener, flushes journal/state and exits naturally. A 10-second bound applies to E and to each service drain; timeout cleanup kills the process group and yields incomplete closure, never PASS. E cannot create descendants; controller records all started children. This is for the named interface guard and mutants only, not arbitrary hostile in-process code. A configurable test-only linger injection verifies bounded closure handling.

Before/after evidence: every namespace's addresses, routes, exact iptables rules, drop counters, IPv6 disable flag, observer file modes; compare configuration text and hashes. A local synthetic non-allowlisted target probe must fail in E/X/R/P/Q and increment a DROP counter before baseline. No probe addresses a real system. Probe checks, missing journals, changed configuration and writable observation channels are technical failures. Late writes after timeout are preserved but cannot establish absence.

Raw run records and evaluated reports use separate versioned formats. Offline evaluation validates schema, complete case set, unique service streams, run/case/attempt identities, hash chains, closure, configuration, channel checks and exact effects. It uses corpus truth, never reported guard decisions as expectations. Semantic replay strips run IDs only after validation. Cross-run substitution is rejected, not normalized away. Collector, service code and Linux kernel remain trusted; no runtime attestation is claimed.
