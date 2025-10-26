import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from "discord.js";
import { animeQuestions } from "./data/anime-questions.js";
import { characterQuestions } from "./data/character-questions.js";

/**
 * Starts the first round or a new round of the game
 */
export async function startRound(game, client, activeGames, userGameMap) {
  try {
    game.state = "answering";
    // Clear data from previous rounds
    game.answers.clear();
    game.votes.clear();
    if (game.answerTimeout) clearTimeout(game.answerTimeout);
    if (game.voteTimeout) clearTimeout(game.voteTimeout);

    // 1. Pick correct question bank based on game.category
    let questionBank;
    if (game.category === "anime") {
      questionBank = animeQuestions;
    } else {
      questionBank = characterQuestions;
    }

    if (!questionBank || questionBank.length < 2) {
      console.error("Not enough questions in the selected bank!");
      const channel = await client.channels.fetch(game.channelId);
      await channel.send(
        "Error: The selected question bank doesn't have enough questions (requires at least 2). Stopping game."
      );
      activeGames.delete(game.channelId);
      return;
    }

    // 2. Pick two DIFFERENT random questions from the bank
    const availableQuestions = [...questionBank]; // Create a copy

    // Pick real question
    const index1 = Math.floor(Math.random() * availableQuestions.length);
    game.realQuestion = availableQuestions.splice(index1, 1)[0]; // .splice removes it

    // Pick impostor question
    const index2 = Math.floor(Math.random() * availableQuestions.length);
    game.impostorQuestion = availableQuestions[index2];

    console.log(
      availableQuestions,
      index1,
      index2,
      game.realQuestion,
      game.impostorQuestion
    );
    // 3. Pick impostor
    const participantsArray = Array.from(game.participants.keys());
    game.impostorId =
      participantsArray[Math.floor(Math.random() * participantsArray.length)];

    console.log(
      `New round started in ${game.channelId}. Impostor is ${game.impostorId}`
    );

    // 4. Edit lobby message
    await game.lobbyMessage.edit({
      content: "The game has started! Check your DMs for your question. 📩",
      embeds: [],
      components: [],
    });

    // 5. DM all participants
    const failedDMs = [];
    for (const [userId, user] of game.participants) {
      const isImpostor = userId === game.impostorId;
      const question = isImpostor ? game.impostorQuestion : game.realQuestion;

      const embed = new EmbedBuilder()
        .setTitle("Your Question Is...")
        .setDescription(`**${question}**}`)
        .setFooter({ text: "Click the button below to submit your answer." });

      const button = new ButtonBuilder()
        .setCustomId("submitAnswerButton")
        .setLabel("Submit Your Answer")
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(button);

      try {
        await user.send({ embeds: [embed], components: [row] });
      } catch (error) {
        console.error(
          `Failed to DM user ${user.id}. They may have DMs closed.`
        );
        failedDMs.push(user); // Add the user to a "failed" list
      }
    }

    // 6. Handle any DM failures
    const channel = await client.channels.fetch(game.channelId);

    if (failedDMs.length > 0) {
      const mentions = failedDMs.map((u) => u.toString()).join(", ");

      await channel.send({
        content: `**Warning!** I could not send a DM to ${mentions}.
This is usually because your privacy settings for this server are set to **disallow DMs from server members**.
*(How to fix: Right-click server icon > Privacy Settings > Allow DMs from server members)*
\n**Removing the player(s) above from this round.**`,
        // This ensures we only ping the users who had the problem
        allowedMentions: { users: failedDMs.map((u) => u.id) },
      });

      // Remove them from the game for this round
      for (const user of failedDMs) {
        game.participants.delete(user.id);
        userGameMap.delete(user.id);
      }
    }

    // 7. Check if enough players are left
    if (game.participants.size < 1) {
      await channel.send(
        "There are not enough players left to continue after the DM failures. Stopping the game."
      );
      activeGames.delete(game.channelId);
      return; // Stop the round from starting
    }

    // 8. Start answer timeout (5 minutes)
    // (This is the original timeout code, just moved down)
    game.answerTimeout = setTimeout(() => {
      const currentGame = activeGames.get(game.channelId);
      if (currentGame && currentGame.state === "answering") {
        console.log(`Game ${game.channelId}: Answer timeout reached.`);
        proceedToVoting(currentGame, client, activeGames);
      }
    }, 300_000); // 300,000ms = 5 minutes
  } catch (error) {
    console.error("Error starting round:", error);
    try {
      const channel = await client.channels.fetch(game.channelId);
      await channel.send(
        "An unknown error occurred while starting the round. Stopping the game."
      );
    } catch (e) {
      console.error("Failed to send error message to channel", e);
    }
    activeGames.delete(game.channelId);
  }
}

/**
 * Moves the game to the voting phase
 */
export async function proceedToVoting(game, client, activeGames, userGameMap) {
  if (game.state !== "answering") return; // Avoid race condition
  game.state = "voting";
  clearTimeout(game.answerTimeout);

  try {
    const channel = await client.channels.fetch(game.channelId);
    let answerList = "";

    // Create a shuffled list of participants for display
    const shuffledParticipants = Array.from(game.participants.values()).sort(
      () => Math.random() - 0.5
    );

    for (const user of shuffledParticipants) {
      const answer = game.answers.get(user.id);
      answerList += `**${user.username}**: ${answer || "*No Answer Submitted*"}\n`;
    }

    const embed = new EmbedBuilder()
      .setColor(0xffff00)
      .setTitle("Time to Vote!")
      .setDescription(
        `The real question was:\n**${game.realQuestion}**\n\nHere are the answers:\n${answerList}`
      )
      .setFooter({
        text: "Discuss! Then, vote using the dropdown menu below.",
      });

    await channel.send({ embeds: [embed] });

    // Build Select Menu
    const options = Array.from(game.participants.values()).map((user) => ({
      label: user.username,
      value: user.id,
      description: `Vote for ${user.username}`,
    }));

    const menu = new StringSelectMenuBuilder()
      .setCustomId("voteMenu")
      .setPlaceholder("Vote for the Impostor")
      .setOptions(options);

    const row = new ActionRowBuilder().addComponents(menu);
    await channel.send({
      content: "Who is the Impostor? 🗳️",
      components: [row],
    });

    // 3. Start voting timeout (3 minutes)
    game.voteTimeout = setTimeout(() => {
      const currentGame = activeGames.get(game.channelId);
      if (currentGame && currentGame.state === "voting") {
        console.log(`Game ${game.channelId}: Voting timeout reached.`);
        proceedToReveal(currentGame, client, activeGames);
      }
    }, 900_000); // 180,000ms = 3 minutes
  } catch (error) {
    console.error("Error proceeding to voting:", error);
    // Handle error, maybe stop game
  }
}

/**
 * Reveals the game results
 */
export async function proceedToReveal(game, client, activeGames, userGameMap) {
  if (game.state !== "voting") return; // Avoid race condition
  game.state = "finished";
  clearTimeout(game.voteTimeout);

  try {
    const channel = await client.channels.fetch(game.channelId);

    // 1. Tally votes
    const voteCounts = new Map();
    for (const votedId of game.votes.values()) {
      voteCounts.set(votedId, (voteCounts.get(votedId) || 0) + 1);
    }

    let result = "Vote Results:\n";
    let maxVotes = 0;
    let mostVotedIds = [];

    for (const [userId, user] of game.participants) {
      const count = voteCounts.get(userId) || 0;
      result += `**${user.username}**: ${count} vote(s)\n`;
      if (count > maxVotes) {
        maxVotes = count;
        mostVotedIds = [user.username];
      } else if (count === maxVotes && maxVotes > 0) {
        mostVotedIds.push(user.username);
      }
    }

    // 2. Build result message
    const impostor = game.participants.get(game.impostorId);

    if (mostVotedIds.length === 0) {
      result += "\nNo votes were cast!\n";
    } else {
      result += `\nThe person (or people) with the most votes was: **${mostVotedIds.join(", ")}**\n`;
    }

    result += `\nThe *real* impostor was... **${impostor.username}**! 🕵️\n\n`;
    result += `Their question was: **${game.impostorQuestion}**`;

    const embed = new EmbedBuilder()
      .setTitle("Game Over! Here are the results:")
      .setDescription(result)
      .setColor(impostor.id === mostVotedIds[0] ? 0x00ff00 : 0xff0000); // Green if impostor caught, red if not (simplified)

    // 3. Add 'Play Again' buttons
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("playAgainButton")
        .setLabel("Play Again (Same Players)")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("endGameButton")
        .setLabel("End Game")
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({ embeds: [embed], components: [row] });
  } catch (error) {
    console.error("Error proceeding to reveal:", error);
  }
}
