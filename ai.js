class AIController {
    constructor(game) {
        this.game = game;
        this.difficulty = 'basic'; // 'easy', 'basic', 'expert', 'impossible'
    }

    planTurn() {
        let enemies = this.game.planes.filter(p => p.team === 'enemy' && !p.isDestroyed);
        let players = this.game.planes.filter(p => p.team === 'player' && !p.isDestroyed);

        if (enemies.length === 0 || players.length === 0) return;

        for (let enemy of enemies) {
            enemy.resetPlan();

            switch (this.difficulty) {
                case 'easy':
                    this.planEasy(enemy, players);
                    break;
                case 'basic':
                    this.planBasic(enemy, players);
                    break;
                case 'expert':
                    this.planExpert(enemy, players);
                    break;
                case 'impossible':
                    this.planImpossible(enemy, players);
                    break;
                default:
                    this.planBasic(enemy, players);
            }
        }
    }

    // =========================================================================
    // EASY AI — Flies toward player, poor mountain awareness, random weapons
    // =========================================================================
    planEasy(enemy, players) {
        let closest = this.getClosestTarget(enemy, players);
        if (!closest) {
            this.flyForward(enemy);
            return;
        }

        // Always fly level, no energy management
        enemy.planned.flightAction = 'level';

        let params = enemy.getMoveParams();
        let d = params.maxDist;

        // Pick a random-ish angle towards the player, no mountain avoidance
        let angleToTarget = Math.atan2(closest.y - enemy.y, closest.x - enemy.x);
        let diff = normalizeAngle(angleToTarget - enemy.heading);
        let clampedAngle = enemy.heading + Math.max(-params.turnAngle, Math.min(params.turnAngle, diff));

        enemy.planned.targetPos = {
            x: enemy.x + Math.cos(clampedAngle) * d,
            y: enemy.y + Math.sin(clampedAngle) * d
        };

        // Weapons: only cannons, occasionally a missile (30% chance)
        let dToTarget = dist(enemy.x, enemy.y, closest.x, closest.y);
        if (dToTarget > enemy.cannonRange * 1.5 && enemy.ammo.missiles > 0 && Math.random() < 0.3 && enemy.isValidMissileTarget(closest)) {
            enemy.planned.weapon = 'missile';
            enemy.planned.missileTarget = closest;
        } else {
            enemy.planned.weapon = 'cannons';
        }
        // Easy AI never uses flares
    }

    // =========================================================================
    // BASIC AI — Current AI with mountain avoidance and evasive fallback
    // =========================================================================
    planBasic(enemy, players) {
        let closest = this.getClosestTarget(enemy, players);

        let angleToClosest = 0;
        let isBehind = false;
        if (closest) {
            angleToClosest = Math.atan2(closest.y - enemy.y, closest.x - enemy.x);
            let diff = Math.abs(normalizeAngle(angleToClosest - enemy.heading));
            if (diff > Math.PI * 0.6) isBehind = true;
        }

        // Flight Action
        if (enemy.energy < 1) {
            enemy.planned.flightAction = 'recover';
        } else if (isBehind && enemy.energy >= 2) {
            enemy.planned.flightAction = 'turnaround';
            enemy.planned.turnDirection = Math.sign(normalizeAngle(angleToClosest - enemy.heading)) || 1;
        } else {
            let r = Math.random();
            if (r < 0.3) enemy.planned.flightAction = 'maneuver';
            else if (r < 0.6) enemy.planned.flightAction = 'boost';
            else enemy.planned.flightAction = 'level';
        }

        if (closest) {
            if (enemy.planned.flightAction === 'turnaround') {
                enemy.planned.targetPos = { x: enemy.x, y: enemy.y };
            } else {
                this.findBestPosition(enemy, closest);
            }
            this.pickWeapon(enemy, closest);
        } else {
            this.flyForward(enemy);
        }
    }

    // =========================================================================
    // EXPERT AI — Predicts player movement, tries to get behind them
    // =========================================================================
    planExpert(enemy, players) {
        let bestTarget = this.pickBestTarget(enemy, players);
        if (!bestTarget) {
            this.flyForward(enemy);
            return;
        }

        // Predict where the player will be next turn
        let predicted = this.predictPlayerPosition(bestTarget);

        let angleToTarget = Math.atan2(predicted.y - enemy.y, predicted.x - enemy.x);
        let angleDiff = Math.abs(normalizeAngle(angleToTarget - enemy.heading));

        // Smart energy management
        let dToTarget = dist(enemy.x, enemy.y, predicted.x, predicted.y);

        if (angleDiff > Math.PI * 0.55 && enemy.energy >= 2) {
            // Target is behind us — turnaround
            enemy.planned.flightAction = 'turnaround';
            enemy.planned.turnDirection = Math.sign(normalizeAngle(angleToTarget - enemy.heading)) || 1;
            enemy.planned.targetPos = { x: enemy.x, y: enemy.y };
        } else if (dToTarget < enemy.cannonRange * 0.6 && enemy.energy >= 1) {
            // Close range — maneuver for evasion
            enemy.planned.flightAction = 'maneuver';
        } else if (dToTarget > enemy.baseMoveDist * 1.5 && enemy.energy >= 1) {
            // Far away — boost to close distance
            enemy.planned.flightAction = 'boost';
        } else if (enemy.energy < 1) {
            enemy.planned.flightAction = 'recover';
        } else {
            enemy.planned.flightAction = 'level';
        }

        if (enemy.planned.flightAction !== 'turnaround') {
            // Try to get BEHIND the predicted position
            let behindAngle = bestTarget.heading + Math.PI; // directly behind where they're facing
            let idealX = predicted.x + Math.cos(behindAngle) * 80;
            let idealY = predicted.y + Math.sin(behindAngle) * 80;

            this.findBestPositionToward(enemy, idealX, idealY, bestTarget);
        }

        // Smart weapons
        this.pickWeaponSmart(enemy, bestTarget, players);
    }

    // =========================================================================
    // IMPOSSIBLE AI — Reads player plans + real-world BFM tactics
    // Uses: lead/lag pursuit, overshoot prevention, scissors, bracket attacks,
    //       terrain masking, energy management, coordinated wingman tactics
    // =========================================================================
    planImpossible(enemy, players) {
        let enemies = this.game.planes.filter(p => p.team === 'enemy' && !p.isDestroyed);
        let bestTarget = this.pickBestTarget(enemy, players);
        if (!bestTarget) {
            this.flyForward(enemy);
            return;
        }

        // CHEAT: Read the player's planned end position and heading
        let playerEnd = this.getPlayerEndPosition(bestTarget);
        let playerEndHeading = bestTarget.planned.targetPos
            ? Math.atan2(bestTarget.planned.targetPos.y - bestTarget.y, bestTarget.planned.targetPos.x - bestTarget.x)
            : bestTarget.heading;
        let playerAction = bestTarget.planned.flightAction;
        let playerWeapon = bestTarget.planned.weapon;

        let dToEnd = dist(enemy.x, enemy.y, playerEnd.x, playerEnd.y);
        let angleToEnd = Math.atan2(playerEnd.y - enemy.y, playerEnd.x - enemy.x);
        let angleDiff = Math.abs(normalizeAngle(angleToEnd - enemy.heading));

        // Determine tactical situation: offensive, defensive, or neutral
        let situation = this.assessSituation(enemy, bestTarget, playerEnd, playerEndHeading);

        // Check for incoming threats (existing missiles + player planning to fire one)
        let incomingMissile = this.game.missiles.find(m => m.target === enemy && !m.isDestroyed && !m.hasHit);
        let playerPlanningMissile = playerWeapon === 'missile' && bestTarget.planned.missileTarget === enemy;
        let incomingDist = incomingMissile ? dist(incomingMissile.x, incomingMissile.y, enemy.x, enemy.y) : Infinity;
        let playerAimingAtUs = this.isPlayerAimingAt(bestTarget, enemy, playerEndHeading);

        // =====================
        // FLIGHT ACTION DECISION
        // =====================
        if (situation === 'defensive') {
            this.planDefensiveBFM(enemy, bestTarget, playerEnd, playerEndHeading, playerWeapon, incomingMissile, incomingDist);
        } else if (situation === 'offensive') {
            this.planOffensiveBFM(enemy, bestTarget, playerEnd, playerEndHeading, playerAction, dToEnd, angleDiff);
        } else {
            this.planNeutralBFM(enemy, bestTarget, playerEnd, playerEndHeading, dToEnd, angleDiff);
        }

        // =====================
        // COORDINATED TACTICS (bracket attacks, drag-and-bag)
        // =====================
        this.applyCoordinatedTactics(enemy, enemies, bestTarget, playerEnd, playerEndHeading, situation);

        // =====================
        // WEAPON DECISION
        // =====================
        this.pickWeaponImpossible(enemy, bestTarget, playerEnd, playerEndHeading, playerAction, incomingMissile, incomingDist, situation);
    }

    assessSituation(enemy, target, playerEnd, playerEndHeading) {
        // Are we behind the player? (offensive)
        let angleFromPlayerToUs = Math.atan2(enemy.y - playerEnd.y, enemy.x - playerEnd.x);
        let behindAngle = Math.abs(normalizeAngle(angleFromPlayerToUs - playerEndHeading));
        // behindAngle near PI means we're behind them

        // Is the player in our front arc?
        let angleFromUsToPlayer = Math.atan2(playerEnd.y - enemy.y, playerEnd.x - enemy.x);
        let frontAngle = Math.abs(normalizeAngle(angleFromUsToPlayer - enemy.heading));

        // HEAD-ON CHECK: if player is in our front AND we're in their front, it's a merge
        let playerFacingUs = behindAngle < Math.PI * 0.5;
        let weFacingPlayer = frontAngle < Math.PI * 0.5;

        if (playerFacingUs && weFacingPlayer) {
            return 'neutral'; // Head-on merge — neither has advantage
        } else if (behindAngle > Math.PI * 0.6 && frontAngle < Math.PI * 0.4) {
            return 'offensive'; // We're behind them and they're in front of us
        } else if (behindAngle < Math.PI * 0.35 && frontAngle > Math.PI * 0.5) {
            return 'defensive'; // We're in front of them AND they're behind us
        }
        return 'neutral';
    }

    isPlayerAimingAt(player, enemy, playerEndHeading) {
        let angleToEnemy = Math.atan2(enemy.y - player.y, enemy.x - player.x);
        let diff = Math.abs(normalizeAngle(angleToEnemy - playerEndHeading));
        return diff < Math.PI / 6; // within 30 degrees
    }

    // -----------------------------------------------------------------------
    // DEFENSIVE BFM — Player is behind us, we need to survive
    // -----------------------------------------------------------------------
    planDefensiveBFM(enemy, target, playerEnd, playerEndHeading, playerWeapon, incomingMissile, incomingDist) {
        let dToPlayer = dist(enemy.x, enemy.y, target.x, target.y);
        let angleToPlayer = Math.atan2(target.y - enemy.y, target.x - enemy.x);
        let missileInbound = incomingMissile && incomingDist < 500;

        if (missileInbound) {
            // MISSILE EVASION — never turnaround into a missile!
            // Priority: maneuver perpendicular to the missile's path, or use terrain
            if (enemy.energy >= 1) {
                enemy.planned.flightAction = 'maneuver';
            } else {
                enemy.planned.flightAction = 'level';
            }

            // Try terrain masking first
            let terrainCover = this.findTerrainMaskPosition(enemy, incomingMissile);
            if (terrainCover) {
                enemy.planned.targetPos = terrainCover;
            } else {
                // Jink perpendicular to missile approach vector
                let missileAngle = Math.atan2(incomingMissile.y - enemy.y, incomingMissile.x - enemy.x);
                let params = enemy.getMoveParams();
                // Go perpendicular — pick the side closer to our heading
                let perpA = missileAngle + Math.PI / 2;
                let perpB = missileAngle - Math.PI / 2;
                let diffA = Math.abs(normalizeAngle(perpA - enemy.heading));
                let diffB = Math.abs(normalizeAngle(perpB - enemy.heading));
                let evadeAngle = diffA < diffB ? perpA : perpB;

                let diff = normalizeAngle(evadeAngle - enemy.heading);
                let clampedAngle = enemy.heading + Math.max(-params.turnAngle, Math.min(params.turnAngle, diff));
                let px = enemy.x + Math.cos(clampedAngle) * params.maxDist;
                let py = enemy.y + Math.sin(clampedAngle) * params.maxDist;

                if (!this.hitsAnyMountain(enemy, px, py)) {
                    enemy.planned.targetPos = { x: px, y: py };
                } else {
                    this.findBestPositionToward(enemy, px, py, target);
                }
            }
            return;
        }

        // No missile — standard defensive BFM against guns
        let shouldBreak = dToPlayer < enemy.baseMoveDist * 1.5;

        if (shouldBreak && enemy.energy >= 1) {
            // Hard break turn with maneuver (dodge + force overshoot)
            enemy.planned.flightAction = 'maneuver';
            let breakAngle = angleToPlayer;
            let params = enemy.getMoveParams();
            let diff = normalizeAngle(breakAngle - enemy.heading);
            let clampedAngle = enemy.heading + Math.max(-params.turnAngle, Math.min(params.turnAngle, diff));

            let px = enemy.x + Math.cos(clampedAngle) * params.maxDist;
            let py = enemy.y + Math.sin(clampedAngle) * params.maxDist;

            if (!this.hitsAnyMountain(enemy, px, py)) {
                enemy.planned.targetPos = { x: px, y: py };
            } else {
                this.findBestPositionToward(enemy, px, py, target);
            }
        } else if (enemy.energy >= 2) {
            // Scissors — turnaround only when no missile is chasing
            enemy.planned.flightAction = 'turnaround';
            enemy.planned.turnDirection = Math.sign(normalizeAngle(angleToPlayer - enemy.heading)) || 1;
            enemy.planned.targetPos = { x: enemy.x, y: enemy.y };
        } else {
            // No energy — recover while jinking
            enemy.planned.flightAction = 'recover';
            let terrainCover = this.findTerrainMaskPosition(enemy, target);
            if (terrainCover) {
                enemy.planned.targetPos = terrainCover;
            } else {
                let params = enemy.getMoveParams();
                let perpAngle = enemy.heading + (Math.random() > 0.5 ? Math.PI/4 : -Math.PI/4);
                let diff = normalizeAngle(perpAngle - enemy.heading);
                let clampedAngle = enemy.heading + Math.max(-params.turnAngle, Math.min(params.turnAngle, diff));
                enemy.planned.targetPos = {
                    x: enemy.x + Math.cos(clampedAngle) * params.minDist,
                    y: enemy.y + Math.sin(clampedAngle) * params.minDist
                };
            }
        }
    }

    // -----------------------------------------------------------------------
    // OFFENSIVE BFM — We're behind the player, press the advantage
    // -----------------------------------------------------------------------
    planOffensiveBFM(enemy, target, playerEnd, playerEndHeading, playerAction, dToEnd, angleDiff) {
        // Check for potential overshoot: will we fly past the player?
        let closingSpeed = dToEnd - dist(enemy.x, enemy.y, target.x, target.y);
        let willOvershoot = dToEnd < enemy.baseMoveDist * 0.7;

        if (willOvershoot && playerAction !== 'turnaround') {
            // Tactic: LAG PURSUIT — Aim behind the target to slow closure rate
            // Instead of flying to where they'll be, fly to where they are NOW
            // This prevents overshooting and keeps us in the kill zone
            if (enemy.energy >= 1) {
                enemy.planned.flightAction = 'maneuver'; // Tight turn to stay behind
            } else {
                enemy.planned.flightAction = 'recover'; // Bleed speed
            }

            // Lag pursuit point: behind and to the side of the target's current position
            let lagAngle = playerEndHeading + Math.PI; // directly behind their heading
            let lagDist = 50; // Stay at close-but-safe distance
            let idealX = playerEnd.x + Math.cos(lagAngle) * lagDist;
            let idealY = playerEnd.y + Math.sin(lagAngle) * lagDist;

            this.findBestPositionToward(enemy, idealX, idealY, target);

        } else if (playerAction === 'turnaround') {
            // Player is turning around — they'll face us! Set up for a head-on merge
            // Use LEAD PURSUIT — aim ahead of where they'll be
            if (enemy.energy >= 1) {
                enemy.planned.flightAction = 'boost'; // Close distance fast before they complete the turn
            } else {
                enemy.planned.flightAction = 'level';
            }

            // Lead pursuit: aim at where they'll end up
            this.findBestPositionToward(enemy, playerEnd.x, playerEnd.y, target);

        } else {
            // Standard offensive: PURE PURSUIT toward the 6 o'clock position
            if (dToEnd > enemy.baseMoveDist * 1.5 && enemy.energy >= 1) {
                enemy.planned.flightAction = 'boost';
            } else if (enemy.energy < 1) {
                enemy.planned.flightAction = 'recover';
            } else {
                enemy.planned.flightAction = 'level';
            }

            // Pure pursuit: aim for the point directly behind their end heading
            let behindX = playerEnd.x + Math.cos(playerEndHeading + Math.PI) * 70;
            let behindY = playerEnd.y + Math.sin(playerEndHeading + Math.PI) * 70;
            this.findBestPositionToward(enemy, behindX, behindY, target);
        }
    }

    // -----------------------------------------------------------------------
    // NEUTRAL BFM — Neither side has advantage, fight for position
    // -----------------------------------------------------------------------
    planNeutralBFM(enemy, target, playerEnd, playerEndHeading, dToEnd, angleDiff) {
        if (angleDiff > Math.PI * 0.5 && enemy.energy >= 2) {
            // Target is behind our beam — turnaround to engage
            let angleToEnd = Math.atan2(playerEnd.y - enemy.y, playerEnd.x - enemy.x);
            enemy.planned.flightAction = 'turnaround';
            enemy.planned.turnDirection = Math.sign(normalizeAngle(angleToEnd - enemy.heading)) || 1;
            enemy.planned.targetPos = { x: enemy.x, y: enemy.y };
        } else if (dToEnd < enemy.baseMoveDist * 0.8) {
            // Close range neutral — maneuver to get angular advantage
            if (enemy.energy >= 1) {
                enemy.planned.flightAction = 'maneuver';
            } else {
                enemy.planned.flightAction = 'level';
            }

            // Try to cut across their turn circle — aim perpendicular to their heading
            let perpAngle = playerEndHeading + Math.PI / 2;
            // Pick the side that's closer to our current heading
            let altPerp = playerEndHeading - Math.PI / 2;
            let diff1 = Math.abs(normalizeAngle(perpAngle - enemy.heading));
            let diff2 = Math.abs(normalizeAngle(altPerp - enemy.heading));
            let chosenAngle = diff1 < diff2 ? perpAngle : altPerp;

            let idealX = playerEnd.x + Math.cos(chosenAngle) * 100;
            let idealY = playerEnd.y + Math.sin(chosenAngle) * 100;
            this.findBestPositionToward(enemy, idealX, idealY, target);
        } else {
            // Far away neutral — close with energy advantage
            if (enemy.energy >= 1 && dToEnd > enemy.baseMoveDist * 1.3) {
                enemy.planned.flightAction = 'boost';
            } else if (enemy.energy < 1) {
                enemy.planned.flightAction = 'recover';
            } else {
                enemy.planned.flightAction = 'level';
            }

            // Lead pursuit intercept — aim where they'll be, not where they are
            this.findBestPositionToward(enemy, playerEnd.x, playerEnd.y, target);
        }
    }

    // -----------------------------------------------------------------------
    // COORDINATED TACTICS — Multiple AI planes work together
    // -----------------------------------------------------------------------
    applyCoordinatedTactics(enemy, allies, target, playerEnd, playerEndHeading, situation) {
        if (allies.length < 2) return; // Need at least 2 planes to coordinate

        // Find other allies targeting the same player
        let otherAllies = allies.filter(a => a !== enemy && !a.isDestroyed);
        if (otherAllies.length === 0) return;

        // Check if another ally is already pursuing this target from behind
        let allyBehindTarget = otherAllies.some(ally => {
            let angleFromTarget = Math.atan2(ally.y - target.y, ally.x - target.x);
            let behindAngle = Math.abs(normalizeAngle(angleFromTarget - target.heading));
            return behindAngle > Math.PI * 0.6;
        });

        if (allyBehindTarget && situation === 'offensive') {
            // BRACKET ATTACK: Ally is already behind the target.
            // We should attack from a different angle (flanking)
            // instead of stacking behind the same target
            if (enemy.planned.flightAction !== 'turnaround') {
                let flankAngle = playerEndHeading + Math.PI / 2;
                let altFlank = playerEndHeading - Math.PI / 2;
                // Pick the flank closer to our heading
                let diff1 = Math.abs(normalizeAngle(flankAngle - enemy.heading));
                let diff2 = Math.abs(normalizeAngle(altFlank - enemy.heading));
                let chosenFlank = diff1 < diff2 ? flankAngle : altFlank;

                let flankX = playerEnd.x + Math.cos(chosenFlank) * 90;
                let flankY = playerEnd.y + Math.sin(chosenFlank) * 90;
                this.findBestPositionToward(enemy, flankX, flankY, target);
            }
        }
    }

    // -----------------------------------------------------------------------
    // TERRAIN MASKING — Hide behind a mountain to break line of sight
    // -----------------------------------------------------------------------
    findTerrainMaskPosition(enemy, threat) {
        let params = enemy.getMoveParams();
        let bestPos = null;
        let bestScore = -Infinity;

        let step = params.turnAngle / 8 + 0.01;
        for (let a = -params.turnAngle; a <= params.turnAngle; a += step) {
            let px = enemy.x + Math.cos(enemy.heading + a) * params.maxDist;
            let py = enemy.y + Math.sin(enemy.heading + a) * params.maxDist;

            if (this.hitsAnyMountain(enemy, px, py)) continue;

            // Score: does a mountain block line-of-sight between this position and the threat?
            let hasCover = this.game.mountains.some(m => {
                let dToLine = this.distToSegment(m, { x: px, y: py }, threat);
                return dToLine < m.radius * 0.8;
            });

            let score = 0;
            if (hasCover) score += 500; // Big bonus for terrain masking
            score -= dist(px, py, threat.x, threat.y) * 0.1; // Slight preference for distance

            if (score > bestScore) {
                bestScore = score;
                bestPos = { x: px, y: py };
            }
        }

        return bestPos;
    }

    // -----------------------------------------------------------------------
    // IMPOSSIBLE WEAPON SELECTION — Reads player plans for perfect counters
    // -----------------------------------------------------------------------
    pickWeaponImpossible(enemy, target, playerEnd, playerEndHeading, playerAction, incomingMissile, incomingDist, situation) {
        // Priority 1: Survive incoming missiles
        if (incomingMissile && incomingDist < 400) {
            if (enemy.ammo.flares > 0) {
                // Check if we can use terrain masking instead of wasting flares
                let canMask = this.game.mountains.some(m => {
                    let dToLine = this.distToSegment(m, enemy, incomingMissile);
                    return dToLine < m.radius * 0.6;
                });
                if (!canMask) {
                    enemy.planned.weapon = 'flares';
                    return;
                }
            }
        }

        let dNow = dist(enemy.x, enemy.y, target.x, target.y);
        let dToEnd = dist(enemy.x, enemy.y, playerEnd.x, playerEnd.y);

        // Priority 2: Missile when out of cannon range and we have a lock
        if (dNow > enemy.cannonRange && enemy.ammo.missiles > 0 && enemy.isValidMissileTarget(target)) {
            // Don't waste missile if player is about to use flares
            if (playerAction !== 'flares' || enemy.ammo.missiles > 1) {
                enemy.planned.weapon = 'missile';
                enemy.planned.missileTarget = target;
                return;
            }
        }

        // Priority 3: Cannons when in range and offensive
        if (situation === 'offensive' && dNow <= enemy.cannonRange * 1.2) {
            enemy.planned.weapon = 'cannons';
            return;
        }

        // Priority 4: Fire missile if player is low HP and we have a lock
        if (enemy.ammo.missiles > 0 && enemy.isValidMissileTarget(target) && target.hp <= target.maxHp * 0.5) {
            enemy.planned.weapon = 'missile';
            enemy.planned.missileTarget = target;
            return;
        }

        enemy.planned.weapon = 'cannons';
    }

    // =========================================================================
    // SHARED UTILITIES
    // =========================================================================

    predictPlayerPosition(player) {
        // Predict where the player will move based on current heading and speed
        let moveD = player.baseMoveDist;
        return {
            x: player.x + Math.cos(player.heading) * moveD,
            y: player.y + Math.sin(player.heading) * moveD
        };
    }

    getPlayerEndPosition(player) {
        // CHEAT: Read the actual planned position
        if (player.planned.flightAction === 'turnaround') {
            return { x: player.x, y: player.y };
        }
        if (player.planned.targetPos) {
            return { x: player.planned.targetPos.x, y: player.planned.targetPos.y };
        }
        // Fallback to prediction
        return this.predictPlayerPosition(player);
    }

    pickBestTarget(enemy, players) {
        // Score targets: prefer low HP, close range, and targets in front arc
        let bestTarget = null;
        let bestScore = -Infinity;

        for (let p of players) {
            if (p.isDestroyed) continue;
            let d = dist(enemy.x, enemy.y, p.x, p.y);
            let angleTo = Math.atan2(p.y - enemy.y, p.x - enemy.x);
            let angleDiff = Math.abs(normalizeAngle(angleTo - enemy.heading));

            let score = 0;
            score -= d * 0.5;                              // Prefer closer
            score -= angleDiff * 100;                      // Prefer targets in front
            score += (1 - p.hp / p.maxHp) * 200;          // Prefer damaged targets
            if (angleDiff < Math.PI / 4) score += 150;    // Big bonus if in front arc

            if (score > bestScore) {
                bestScore = score;
                bestTarget = p;
            }
        }
        return bestTarget;
    }

    findBestPositionToward(enemy, idealX, idealY, fallbackTarget) {
        let params = enemy.getMoveParams();
        let bestPos = null;
        let bestScore = -Infinity;
        let d = params.maxDist;

        // Fine-grained angle sampling (16 samples)
        let step = params.turnAngle / 8 + 0.01;
        for (let a = -params.turnAngle; a <= params.turnAngle; a += step) {
            let px = enemy.x + Math.cos(enemy.heading + a) * d;
            let py = enemy.y + Math.sin(enemy.heading + a) * d;

            if (this.hitsAnyMountain(enemy, px, py)) continue;

            // Score: minimize distance to ideal position
            let score = -dist(px, py, idealX, idealY);

            // Bonus for staying on the map
            if (px > 30 && px < this.game.canvas.width - 30 && py > 30 && py < this.game.canvas.height - 30) {
                score += 50;
            }

            if (score > bestScore) {
                bestScore = score;
                bestPos = { x: px, y: py };
            }
        }

        if (bestPos) {
            enemy.planned.targetPos = bestPos;
        } else {
            this.evasiveFallback(enemy, params);
        }
    }

    findBestPosition(enemy, closest) {
        let params = enemy.getMoveParams();
        let bestPos = null;
        let bestScore = -Infinity;
        let d = params.maxDist;

        let step = params.turnAngle / 4 + 0.01;
        for (let a = -params.turnAngle; a <= params.turnAngle; a += step) {
            let px = enemy.x + Math.cos(enemy.heading + a) * d;
            let py = enemy.y + Math.sin(enemy.heading + a) * d;

            if (this.hitsAnyMountain(enemy, px, py)) continue;

            let score = -dist(px, py, closest.x, closest.y);
            if (score > bestScore) {
                bestScore = score;
                bestPos = { x: px, y: py };
            }
        }

        if (bestPos) {
            enemy.planned.targetPos = bestPos;
        } else {
            this.evasiveFallback(enemy, params);
        }
    }

    evasiveFallback(enemy, params) {
        // All forward paths hit mountains. Find the safest angle or turnaround.
        let d = params.maxDist;
        let maxSafeDist = -1;
        let safeAngle = 0;

        let step = params.turnAngle / 4 + 0.01;
        for (let a = -params.turnAngle; a <= params.turnAngle; a += step) {
            let px = enemy.x + Math.cos(enemy.heading + a) * d;
            let py = enemy.y + Math.sin(enemy.heading + a) * d;

            let closestMntD = Infinity;
            for (let m of this.game.mountains) {
                let dToLine = this.distToSegment(m, enemy, { x: px, y: py });
                if (dToLine < m.radius + enemy.radius * 2 + 10) {
                    let mD = dist(enemy.x, enemy.y, m.x, m.y);
                    if (mD < closestMntD) closestMntD = mD;
                }
            }

            if (closestMntD > maxSafeDist) {
                maxSafeDist = closestMntD;
                safeAngle = a;
            }
        }

        if (enemy.energy >= 2 && maxSafeDist < params.minDist + 80) {
            enemy.planned.flightAction = 'turnaround';
            enemy.planned.turnDirection = 1;
            enemy.planned.targetPos = { x: enemy.x, y: enemy.y };
        } else {
            enemy.planned.flightAction = 'recover';
            let recParams = enemy.getMoveParams();
            enemy.planned.targetPos = {
                x: enemy.x + Math.cos(enemy.heading + safeAngle) * recParams.minDist,
                y: enemy.y + Math.sin(enemy.heading + safeAngle) * recParams.minDist
            };
        }
    }

    hitsAnyMountain(enemy, px, py) {
        return this.game.mountains.some(m => {
            let dToLine = this.distToSegment(m, enemy, { x: px, y: py });
            return dToLine < m.radius + enemy.radius * 2 + 10;
        });
    }

    pickWeapon(enemy, closest) {
        let d = dist(enemy.x, enemy.y, closest.x, closest.y);
        let incoming = this.game.missiles.some(m => m.target === enemy && dist(m.x, m.y, enemy.x, enemy.y) < 350);

        if (incoming && enemy.ammo.flares > 0) {
            enemy.planned.weapon = 'flares';
        } else if (d > enemy.cannonRange && enemy.ammo.missiles > 0 && enemy.isValidMissileTarget(closest)) {
            enemy.planned.weapon = 'missile';
            enemy.planned.missileTarget = closest;
        } else {
            enemy.planned.weapon = 'cannons';
        }
    }

    pickWeaponSmart(enemy, bestTarget, players) {
        let incoming = this.game.missiles.some(m => m.target === enemy && dist(m.x, m.y, enemy.x, enemy.y) < 350);
        let d = dist(enemy.x, enemy.y, bestTarget.x, bestTarget.y);

        if (incoming && enemy.ammo.flares > 0) {
            enemy.planned.weapon = 'flares';
        } else if (d > enemy.cannonRange * 0.8 && enemy.ammo.missiles > 0 && enemy.isValidMissileTarget(bestTarget)) {
            enemy.planned.weapon = 'missile';
            enemy.planned.missileTarget = bestTarget;
        } else if (d <= enemy.cannonRange) {
            enemy.planned.weapon = 'cannons';
        } else if (enemy.ammo.missiles > 0) {
            // Look for any target in missile range
            for (let p of players) {
                if (!p.isDestroyed && enemy.isValidMissileTarget(p)) {
                    enemy.planned.weapon = 'missile';
                    enemy.planned.missileTarget = p;
                    return;
                }
            }
            enemy.planned.weapon = 'cannons';
        } else {
            enemy.planned.weapon = 'cannons';
        }
    }

    flyForward(enemy) {
        enemy.planned.targetPos = {
            x: enemy.x + Math.cos(enemy.heading) * enemy.baseMoveDist,
            y: enemy.y + Math.sin(enemy.heading) * enemy.baseMoveDist
        };
    }

    getClosestTarget(plane, targets) {
        let minD = Infinity;
        let closest = null;
        targets.forEach(t => {
            if (t.isDestroyed) return;
            let d = dist(plane.x, plane.y, t.x, t.y);
            if (d < minD) {
                minD = d;
                closest = t;
            }
        });
        return closest;
    }

    distToSegment(p, v, w) {
        let l2 = dist(v.x, v.y, w.x, w.y);
        l2 = l2 * l2;
        if (l2 == 0) return dist(p.x, p.y, v.x, v.y);
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        return dist(p.x, p.y, v.x + t * (w.x - v.x), v.y + t * (w.y - v.y));
    }
}
