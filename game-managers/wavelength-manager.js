import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
} from "discord.js";

function createProgressBar(value, max = 100, size = 20) {
  const percentage = value / max;
  const progress = Math.round(size * percentage);
  const emptyProgress = size - progress;
  return `[${"▇".repeat(progress)}${"—".repeat(emptyProgress)}]`;
}

export async function initWavelengthRound(
  game,
  client,
  activeGames,
  threadToGameMap,
  keepSpectrum = false
) {
  try {
    game.roundNumber++;
    game.guesses.clear();
    game.clue = null;

    if (game.activeThreads.size > 0) {
      console.log(
        `Cleaning up ${game.activeThreads.size} threads from previous round.`
      );
      for (const threadId of game.activeThreads.values()) {
        threadToGameMap.delete(threadId);
        try {
          const thread = await client.channels.fetch(threadId);
          await thread.delete("Game round ended.");
        } catch (e) {
          console.error(
            `Failed to delete old thread (${threadId}):`,
            e.message
          );
        }
      }
      game.activeThreads.clear();
    }

    // 1. Rotate psychic
    const participantsArray = Array.from(game.participants.values());
    game.psychicIndex = (game.psychicIndex + 1) % participantsArray.length;
    const psychicUser = participantsArray[game.psychicIndex];
    game.psychicId = psychicUser;

    // 2. Decide spectrum
    if (keepSpectrum && game.spectrum) {
      await startPsychicPhase(game, client, threadToGameMap);
    } else {
      game.state = "waiting_for_spectrum";
      await requestSpectrum(game, client);
    }
  } catch (err) {
    console.error("Error init Wavelength round:", err);
  }
}

async function requestSpectrum(game, client) {
  const embed = new EmbedBuilder()
    .setTitle(`Round ${game.roundNumber}: Setup`)
    .setDescription(
      "Please define the spectrum for this round.\n(ex: Hot - Cold)"
    )
    .setColor(0xf1c40f);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wl_setSpectrum_${game.roundNumber}`)
      .setLabel("Set Spectrum Parameters")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("⚙️")
  );

  await game.lobbyMessage.edit({
    content: `Starting round ${game.roundNumber}...`,
    embeds: [embed],
    components: [row],
  });
}

export async function startPsychicPhase(game, client, threadToGameMap) {
  game.state = "psychic_phase";
  game.target = Math.floor(Math.random() * 101);

  let psychicUser = game.participants.get(game.psychicId);

  if (!psychicUser) {
    console.warn(
      `[Warning] Psychic (ID: ${game.psychicId}) not found in participants. Picking a new one.`
    );
    const availableParticipants = Array.from(game.participants.values());

    if (availableParticipants.length === 0) {
      return game.lobbyMessage.edit({
        content: "Everyone left the game! Ending...",
        embeds: [],
        components: [],
      });
    }

    // Pick random new psychic
    const newPsychic =
      availableParticipants[
        Math.floor(Math.random() * availableParticipants.length)
      ];
    game.psychicId = newPsychic.id;
    psychicUser = newPsychic; // Update the variable
  }

  // Update Main Channel
  try {
    await game.lobbyMessage.edit({
      content: `**Round ${game.roundNumber}**\nPsychic: **${psychicUser.username}**\nSpectrum: **${game.spectrum.left}** <---> **${game.spectrum.right}**\n\nWaiting for the Psychic to give a clue... 🧠`,
      embeds: [],
      components: [],
    });
  } catch (error) {
    console.error("Failed to edit lobby message:", error);
  }

  // Create Private Thread
  try {
    const channel = await client.channels.fetch(game.channelId);
    const thread = await channel.threads.create({
      name: `Psychic Area - Round ${game.roundNumber}`,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 60,
    });

    await thread.members.add(psychicUser.id);
    game.activeThreads.set(psychicUser.id, thread.id);
    threadToGameMap.set(thread.id, game.channelId);

    // Send Secret Info
    const embed = new EmbedBuilder()
      .setTitle("You are the Psychic! 🔮")
      .setDescription(
        `The Spectrum is:\n# ${game.spectrum.left} <-----> ${game.spectrum.right}\n\nThe Target is: **${game.target} / 100**`
      )
      .addFields({
        name: "Visual Guide",
        value: `${game.spectrum.left} ${createProgressBar(game.target)} ${game.spectrum.right}`,
      })
      .setFooter({ text: "Give a clue that matches this position!" });

    const btn = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wl_giveClue_${game.roundNumber}`)
        .setLabel("Give Clue")
        .setStyle(ButtonStyle.Primary)
    );

    await thread.send({
      content: `${psychicUser.toString()}`,
      embeds: [embed],
      components: [btn],
    });
  } catch (error) {
    console.error("Error creating psychic thread:", error);
  }
}

export async function handleClueSubmission(game, client, clueText) {
  game.state = "guessing_phase";
  game.clue = clueText;

  const channel = await client.channels.fetch(game.channelId);

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("Choosing time!")
    .setDescription(
      `Spectrum: **${game.spectrum.left}** <---> **${game.spectrum.right}**\n\nClue: # **"${clueText}"**`
    )
    .setFooter({ text: "Where does this clue fit on the spectrum? (0-100)" });

  const btn = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wl_guess_${game.roundNumber}`)
      .setLabel("Submit Guess (0-100)")
      .setStyle(ButtonStyle.Success)
  );

  await channel.send({
    content: "Everyone place your guesses!",
    embeds: [embed],
    components: [btn],
  });
}

export async function revealWavelengthResult(
  game,
  client,
  activeGames,
  threadToGameMap
) {
  game.state = "finished";
  const channel = await client.channels.fetch(game.channelId);

  // ... (Calculation logic same as before) ...
  let total = 0;
  let count = 0;
  let guessDetails = "";
  for (const [userId, val] of game.guesses) {
    const user = game.participants.get(userId);
    if (userId === game.psychicId) continue;
    total += val;
    count++;
    guessDetails += `${user.username}: ${val}\n`;
  }
  // If count is 0 handling... (keep your existing logic)
  if (count === 0) total = 0; // Prevent NaN

  const avgGuess = count > 0 ? Math.round(total / count) : 0;
  const diff = Math.abs(game.target - avgGuess);

  let score = 0;
  let message = "";
  if (diff <= 3) {
    score = 4;
    message = "PERFECT! 🎯";
  } else if (diff <= 10) {
    score = 3;
    message = "Great job! 👏";
  } else if (diff <= 20) {
    score = 2;
    message = "Not bad.";
  } else {
    score = 0;
    message = "Way off! 😬";
  }

  const embed = new EmbedBuilder()
    .setTitle(`Result: ${message}`)
    .setDescription(
      `Target: **${game.target}**\nGroup Guess: **${avgGuess}**\nDifference: **${diff}**\n\n**Points: ${score}**`
    )
    .addFields(
      {
        name: "Target Location",
        value: `${game.spectrum.left} ${createProgressBar(game.target)} ${game.spectrum.right}`,
      },
      {
        name: "Group Guess",
        value: `${game.spectrum.left} ${createProgressBar(avgGuess)} ${game.spectrum.right}`,
      },
      { name: "Individual Guesses", value: guessDetails || "None" }
    )
    .setColor(score > 0 ? 0x00ff00 : 0xff0000);

  // --- CHANGED: New Buttons for Next Round ---
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("wl_nextRound_new")
      .setLabel("Change Extrema")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("wl_nextRound_same")
      .setLabel("Keep Extrema")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("endGameButton")
      .setLabel("End Game")
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({ embeds: [embed], components: [row] });
}
