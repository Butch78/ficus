#!/bin/sh
# The sandbox container's entrypoint. All work arrives through the platform's
# exec; this only marks the container ready and stays alive. The egress CA is
# trusted later, by trust-egress.sh, once the sandbox has turned HTTPS
# interception on (the CA does not exist before that).
set -eu
mkdir -p /work /run
# POSIX shared memory: the container has no /dev/shm, and Python's
# multiprocessing needs it for semaphores.
mkdir -p /dev/shm && chmod 1777 /dev/shm
touch /run/ficus-ready
exec sleep infinity
