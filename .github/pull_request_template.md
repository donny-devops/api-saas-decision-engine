## What & why

<!-- One or two sentences. Link the issue. -->

## Type
- [ ] Model / driver change (changes financial outputs)
- [ ] Platform / API
- [ ] Agents / pipelines
- [ ] CI / infra / docs

## Model impact
<!-- For driver or formula changes, paste `node src/cli/index.js compare` before and after. -->

| Scenario | Ending ARR before | after | Min cash before | after |
|---|---|---|---|---|

## Checklist
- [ ] `npm test` and `npm run lint` pass
- [ ] `npm run scan:secrets` is clean; no credentials in code, fixtures or logs
- [ ] New drivers are documented in `docs/model.md`
- [ ] API changes are reflected in `docs/openapi.yaml`
