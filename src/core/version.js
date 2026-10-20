/* =========================================================================
   Release version, shown bottom-right of the main menu.

   Rule (per maintainer): starts at 0.0.1; every release to production
   bumps +0.0.1, milestone releases (new map zone / campaign / season-grade
   content) bump +0.1.0.

   History (backfilled 2026-10-20 from deploy/ artifacts + git log):
     0.0.1  10-18 10:24  dist.tar.gz          initial slice
     0.0.2  10-18 15:11  dist-sprint2.tar.gz  sprint 2
     0.0.3  10-18 16:07  dist-sprintB.tar.gz  sprint B (sync commit 16:42)
     0.1.0  10-18 17:03  dist-sprintB2.tar.gz backyard zone expansion
     0.2.0  10-18 18:03  dist-sprintC.tar.gz  SSAO/ragdoll/art pass
     0.3.0  10-19 22:55  sync site build      campaign + north checkpoint + voices
   ========================================================================= */
export const GAME_VERSION = '0.3.4';
