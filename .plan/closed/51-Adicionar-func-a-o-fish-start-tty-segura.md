# Add safe start_tty fish function

## Objective
Create `/home/alex/.config/fish/functions/start_tty.fish` to free graphical session resources without rebooting and without indiscriminately killing AI processes.

## Implementation
- Require execution in Linux console `/dev/ttyN`, refusing graphical terminals, SSH, and pipelines.
- Explain that stopping SDDM ends the graphical session and its applications; require explicit confirmation.
- Execute only `sudo systemctl stop sddm.service`, propagating failures.
- Do not alter the boot default, do not unload the NVIDIA driver, and do not execute the function during implementation.
- Explain how to check VRAM (`nvidia-smi`) and restore graphical login (`sudo systemctl start sddm`). Do not promise to stop desktop-independent services.

## Validation
Validate syntax with `fish --no-config --no-execute` and test safe refusal in a non-TTY terminal without loading personal config. Use the goal to guide work after approval and complete it after validation.
