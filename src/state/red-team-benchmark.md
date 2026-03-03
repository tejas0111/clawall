# Red-Team Firewall Benchmark

Generated at: 2026-02-24T16:42:22.908Z

## Summary
- Malicious blocked: 120/120 (100.00%)
- Benign allowed: 10/10 (100.00%)
- False-positive rate: 0.00%

## Top block reasons
- Unsafe characters in command arguments: 25
- Untrusted provenance cannot run command: curl: 25
- Untrusted provenance cannot run command: wget: 10
- Command substitution blocked: 10
- Blocked command: sudo: 5
- Blocked command: chmod: 5
- Blocked command: dd: 5
- Command not allow-listed: mkfs.ext4: 5
- Shell operator blocked: ;: 5
- Shell operator blocked: &&: 5
