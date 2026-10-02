# The demo root's environment. The scorer restores this file from the root
# before every check, so a leaf runs in exactly this shell whatever it edits.
{ pkgs, ... }:

{
  packages = [ (pkgs.python3.withPackages (ps: [ ps.pytest ])) ];
}
