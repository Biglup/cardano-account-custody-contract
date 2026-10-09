# Security review

The security review is split by subject. The security documents in
[docs/security](security/README.md) state the scope, the invariants, the
trust assumptions, the threat model and the known issues.
[Verification](verification.md) holds the tests behind each claim, the
execution budgets and the findings. The table maps each section of the
review to its new location.

| Former section | New location |
| --- | --- |
| Introduction and method | [Security](security/README.md), [Threat model](security/threat-model.md), [Verification: conventions](verification.md#conventions) |
| Scope | [Security: scope](security/README.md#scope); the toolchain and the test suites in [Verification: test suites](verification.md#test-suites) and [Verification: conventions](verification.md#conventions) |
| Threat model | Keys and roles in [Trust assumptions](security/trust-assumptions.md); the properties of the proxy, the stake script and `logic_v1` in [Invariants](security/invariants.md); assets and attackers in [Threat model](security/threat-model.md#assets) |
| Double satisfaction | [Threat model](security/threat-model.md#double-satisfaction), [tests](verification.md#double-satisfaction) |
| Missing UTxO authentication | [Threat model](security/threat-model.md#missing-utxo-authentication), [tests](verification.md#missing-utxo-authentication) |
| Datum hijacking | [Threat model](security/threat-model.md#datum-hijacking), [tests](verification.md#datum-hijacking) |
| Token forgery and other token names | [Threat model](security/threat-model.md#token-forgery-and-other-token-names), [tests](verification.md#token-forgery-and-other-token-names) |
| Logic substitution and the upgrade path | [Threat model](security/threat-model.md#logic-substitution-and-the-upgrade-path), [tests](verification.md#logic-substitution-and-the-upgrade-path) |
| Other redeemer | [Threat model](security/threat-model.md#other-redeemer), [tests](verification.md#other-redeemer) |
| Missed input validation | [Threat model](security/threat-model.md#missed-input-validation), [tests](verification.md#missed-input-validation) |
| Time handling | [Threat model](security/threat-model.md#time-handling), [tests](verification.md#time-handling) |
| Unbounded datum, inputs and value | [Threat model](security/threat-model.md#unbounded-datum-inputs-and-value), [tests](verification.md#unbounded-datum-inputs-and-value) |
| UTxO contention | [Threat model](security/threat-model.md#utxo-contention), [tests](verification.md#utxo-contention) |
| Locked value | [Threat model](security/threat-model.md#locked-value), [tests](verification.md#locked-value) |
| Staking and certificates | [Threat model](security/threat-model.md#staking-and-certificates), [tests](verification.md#staking-and-certificates) |
| Evaluation order | [Threat model](security/threat-model.md#evaluation-order), [tests](verification.md#evaluation-order) |
| Signature replay across transactions, accounts and networks | [Threat model](security/threat-model.md#signature-replay), [tests](verification.md#signature-replay) |
| Dust attacks | [Threat model](security/threat-model.md#dust-attacks), [tests](verification.md#dust-attacks) |
| Resource exhaustion | The budget tables and on-chain figures in [Verification: resource exhaustion](verification.md#resource-exhaustion); complexity and reference scripts in [Threat model](security/threat-model.md#resource-exhaustion), with their [tests](verification.md#reference-scripts) |
| Findings and how each was closed | [Verification: findings](verification.md#findings-and-how-each-was-closed) |
| Residual risks and recommendations | [Known issues](security/known-issues.md); the parameter choices in [Verification: observations](verification.md#observations) |
| Audit scope | [Security: the two parts under audit](security/README.md#the-two-parts-under-audit) and [scope](security/README.md#scope); what every later logic must keep in [Invariants](security/invariants.md#obligations-of-every-logic) |
