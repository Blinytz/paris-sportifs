-- Réparation après rejeu accidentel de l'ancienne migration refonte.sql.
--
-- Cette requête ne crédite aucun Éclat. Elle remet simplement à disposition
-- les gains/remboursements que l'ancienne migration a marqués « collectés »
-- sans trouver l'écriture correspondante dans eclats_ledger.
--
-- Elle est idempotente : la rejouer ne change rien de plus.

with repaired as (
  update bets b
  set collected_at = null
  where b.status in ('won', 'void')
    and b.resolved_at is not null
    and b.collected_at = b.resolved_at
    and not exists (
      select 1
      from eclats_ledger l
      where l.user_id = b.user_id
        and l.reference_id = b.id
        and l.source in (
          'paris_sportifs_gain',
          'paris_sportifs_remboursement'
        )
    )
  returning b.status
)
select
  count(*) as elements_repares,
  count(*) filter (where status = 'won') as gains_restaures,
  count(*) filter (where status = 'void') as remboursements_restaures
from repaired;
