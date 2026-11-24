# Research context / Tutkimustausta

[English](#english) | [Suomi](#suomi)

## English

### Reference

Elmasry, M. A. (2026). *Authorization assurance for tool-using LLM agents: a structured review of enforcement semantics and effect-level security evidence*. International Journal of Information Security, 25, article 186. Published 10 November 2026. https://doi.org/10.1007/s10207-026-01343-w

The review examines whether authorization claims are supported by observations at the relevant enforcement and protected-resource boundaries. Within its selected corpus (coverage cutoff 15 July 2026), no evaluable revocation claim was identified among 21 agent-focused sources. This is a corpus-specific finding, not a claim about all existing systems. Its Minimum Authorization-Assurance Profile (MAAP) is a preliminary reporting framework, not a validated certification or scoring instrument.

### Correspondence with this repository

This is a thematic comparison prepared by the project, not an independent assessment or a claim of MAAP conformance.

| Research theme | Repository evidence and status | Remaining boundary |
| --- | --- | --- |
| Authorization decision versus protected effect | Implemented: [ACS evaluation specification](../evaluation-spec.md) and [revocation specification](../revocation/evaluation-spec.md) distinguish decision evidence from observed execution and delivery effects. | Observations support only the encoded predicates and declared observation channels. |
| Revocation and containment | Implemented and evaluated under the declared profile: revocation-0.4.0, 23 of 27 corpus cases in profile and PASS; four out of scope. See [pinned runtime review](../revocation/sut-pin-review-ef775db.md). | Full-contract acceptance is false; profile results are not full-contract or production assurance. Imported observations are not independently verified. |
| Alternative execution paths and external effects | Implemented: [P1b](../external-actions/p1b.md) and [P2](../external-actions/p2.md) use bounded synthetic environments. The [P2 review](../external-actions/p2-review.md) records separate component and live-recipient evidence and the scoped matrix gate. | Historical reports retain p2_acceptance: false. Matrix gate success is not overall P2 acceptance or production validation. |
| Evidence traceability and assumptions | Implemented: [control, evaluation and evidence architecture](../architecture/control-evaluation-evidence.md) and track-specific manifests and reports. | Hash binding does not establish observation fidelity or universal path coverage. |
| MAAP and effective authority | Candidate for future comparison; no formal MAAP mapping or compliance assessment is claimed here. | A separate obligation-by-obligation analysis would be required. |

### Provenance and limits

The repository already contains a traceable revocation-0.3.0 implementation in [merge commit 1e1d359](https://github.com/mikko-lab/agent-control-evals/commit/1e1d359ad8f27e6bb1bda698de1b6ab89e432599). This comparison is anchored to repository commit [6aa2f61](https://github.com/mikko-lab/agent-control-evals/commit/6aa2f61dbf857bf806eced47c2623efe2fd510eb). No priority or novelty claim is made.

The paper is external research. This citation does not imply affiliation, collaboration, endorsement, independent validation, certification or a security guarantee. No new tests or acceptance decisions result from this documentation.

## Suomi

### Lähde

Elmasry, M. A. (2026). *Authorization assurance for tool-using LLM agents: a structured review of enforcement semantics and effect-level security evidence*. International Journal of Information Security, 25, artikkeli 186. Julkaistu 10.11.2026. https://doi.org/10.1007/s10207-026-01343-w

Katsaus tarkastelee, vastaavatko valtuutuksia koskevien väitteiden perusteena olevat havainnot toimeenpanon ja suojatun resurssin olennaisia rajoja. Valitussa aineistossa (hakurajaus 15.7.2026) ei tunnistettu arvioitavaa revokaatioväitettä 21 agentteihin keskittyvän lähteen joukosta. Havainto koskee rajattua aineistoa, ei kaikkia olemassa olevia järjestelmiä. Tutkimuksen MAAP on alustava raportointikehys, ei validoitu sertifiointi- tai pisteytysmenetelmä.

### Yhteys repositorioon

Vertailu on projektin oma temaattinen tarkastelu, ei riippumaton arviointi eikä väite MAAP-vaatimusten täyttämisestä.

| Tutkimusteema | Repositorion evidenssi ja tila | Jäljellä oleva rajaus |
| --- | --- | --- |
| Valtuutuspäätös ja suojattuun resurssiin kohdistuva vaikutus | Toteutettu: [ACS-arviointimääritys](../evaluation-spec.md) ja [revokaatiomääritys](../revocation/evaluation-spec.md) erottavat päätösevidenssin havaituista suoritus- ja toimitusvaikutuksista. | Havainnot tukevat vain määriteltyjä ehtoja ja havaintokanavia. |
| Revokaatio ja vaikutusten rajaaminen | Toteutettu ja arvioitu määritellyssä profiilissa: revocation-0.4.0, 23/27 tapausta profiilissa ja PASS; neljä rajauksen ulkopuolella. [Runtime-katselmointi](../revocation/sut-pin-review-ef775db.md). | Koko arviointisopimuksen hyväksyntä on false; profiilitulos ei osoita koko sopimuksen täyttymistä tai tuotantoturvallisuutta. Tuotuja havaintoja ei varmenneta riippumattomasti. |
| Vaihtoehtoiset suoritusreitit ja ulkoiset vaikutukset | Toteutettu: [P1b](../external-actions/p1b.md) ja [P2](../external-actions/p2.md) rajatuissa synteettisissä ympäristöissä. [P2-katselmointi](../external-actions/p2-review.md) erottaa komponentti- ja vastaanottajaevidenssin sekä rajatun matriisiportin. | Historiallisissa raporteissa p2_acceptance: false. Matriisiportin läpäisy ei tarkoita P2:n kokonaishyväksyntää tai tuotantovalidointia. |
| Evidenssin jäljitettävyys ja oletukset | Toteutettu: [arkkitehtuuri](../architecture/control-evaluation-evidence.md) sekä arviointikohtaiset manifestit ja raportit. | Tiivistesidonta ei osoita havaintojen paikkansapitävyyttä eikä kaikkien reittien kattavuutta. |
| MAAP ja tosiasiallinen toimivalta | Mahdollinen jatkovertailun kohde; muodollista MAAP-kartoitusta tai vaatimustenmukaisuusarviointia ei tässä esitetä. | Edellyttää erillistä velvoitekohtaista analyysia. |

### Alkuperä ja rajaukset

Revocation-0.3.0-toteutus on jäljitettävissä [merge-commitiin 1e1d359](https://github.com/mikko-lab/agent-control-evals/commit/1e1d359ad8f27e6bb1bda698de1b6ab89e432599). Vertailun lähtökohtana on repositorion commit [6aa2f61](https://github.com/mikko-lab/agent-control-evals/commit/6aa2f61dbf857bf806eced47c2623efe2fd510eb). Etusija- tai uutuusväitettä ei esitetä.

Viittaus ulkopuoliseen tutkimukseen ei tarkoita sidonnaisuutta, yhteistyötä, hyväksyntää, riippumatonta validointia, sertifiointia tai turvallisuustakuuta. Dokumentaatiomuutos ei tuota uusia testituloksia eikä muuta hyväksyntäpäätöksiä.
