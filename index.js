import {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
  Partials,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Import game logic
import {
  startRound,
  proceedToVoting,
  proceedToReveal,
} from "./game-manager.js";
// Import lobby helper
import { createLobbyEmbed } from "./commands/startgame.js";

dotenv.config();

// __dirname replacement for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    // Note: Reactions are not needed for this button-based lobby
  ],
  partials: [Partials.Channel], // Required for DMs
});

// Central state manager
const activeGames = new Map();

// --- Command Loading ---
client.commands = new Collection();
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith(".js"));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = (await import(filePath)).default; // Use default export
  if ("data" in command && "execute" in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(
      `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`
    );
  }
}

// --- Event Handlers ---

client.once(Events.ClientReady, () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);
});

// Central Interaction Handler
client.on(Events.InteractionCreate, async (interaction) => {
  // 1. Handle Slash Commands
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      // Pass the activeGames map to the command
      await command.execute(interaction, activeGames);
    } catch (error) {
      console.error(error);
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    }
    return;
  }

  // 2. Handle Buttons
  if (interaction.isButton()) {
    const { customId, user, channelId } = interaction;
    const game = activeGames.get(channelId);

    // --- Lobby Buttons (in channel) ---
    if (game && game.state === "lobby") {
      if (customId === "joinGame") {
        game.participants.set(user.id, user);
        const embed = createLobbyEmbed(
          game.participants.get(game.hostId),
          game.participants
        );
        await game.lobbyMessage.edit({ embeds: [embed] });
        await interaction.reply({
          content: "You have joined the game! 🎉",
          ephemeral: true,
        });
      } else if (customId === "leaveGame") {
        if (user.id === game.hostId) {
          return interaction.reply({
            content: "The host cannot leave! Use /stopgame to end the game.",
            ephemeral: true,
          });
        }
        game.participants.delete(user.id);
        const embed = createLobbyEmbed(
          game.participants.get(game.hostId),
          game.participants
        );
        await game.lobbyMessage.edit({ embeds: [embed] });
        await interaction.reply({
          content: "You have left the game.",
          ephemeral: true,
        });
      } else if (customId === "startGame") {
        if (user.id !== game.hostId) {
          return interaction.reply({
            content: "Only the host can start the game!",
            ephemeral: true,
          });
        }
        if (game.participants.size < 3) {
          // Minimum 3 players
          return interaction.reply({
            content: "You need at least 3 players to start!",
            ephemeral: true,
          });
        }
        await interaction.deferUpdate(); // Acknowledge the button click
        await startRound(game, client, activeGames);
      }
      return;
    }

    // --- Answer Button (in DM) ---
    if (customId === "submitAnswerButton") {
      // Find the game this user is in (since this is a DM)
      let userGame;
      for (const g of activeGames.values()) {
        if (g.participants.has(user.id) && g.state === "answering") {
          userGame = g;
          break;
        }
      }
      if (!userGame) {
        return interaction.reply({
          content:
            "I couldn't find an active game for you, or it's not time to answer.",
          ephemeral: true,
        });
      }
      if (userGame.answers.has(user.id)) {
        return interaction.reply({
          content: "You have already submitted an answer for this round.",
          ephemeral: true,
        });
      }

      // Show Modal
      const modal = new ModalBuilder()
        .setCustomId("answerModal")
        .setTitle("Submit Your Answer");

      const answerInput = new TextInputBuilder()
        .setCustomId("answerInput")
        .setLabel("What is your answer?")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(answerInput));
      await interaction.showModal(modal);
      return;
    }

    // --- End-of-Game Buttons (in channel) ---
    if (game && game.state === "finished") {
      if (user.id !== game.hostId) {
        return interaction.reply({
          content: "Only the host can restart or end the game.",
          ephemeral: true,
        });
      }

      if (customId === "playAgainButton") {
        await interaction.update({
          content: "Starting a new round with the same players...",
          embeds: [],
          components: [],
        });
        await startRound(game, client, activeGames); // Re-run the start logic
      } else if (customId === "endGameButton") {
        await interaction.update({
          content: "This game has ended. Thanks for playing!",
          embeds: [],
          components: [],
        });
        activeGames.delete(channelId);
      }
      return;
    }
  }

  // 3. Handle Modal Submissions
  if (interaction.isModalSubmit()) {
    if (interaction.customId === "answerModal") {
      // Find the game this user is in
      let game;
      for (const g of activeGames.values()) {
        if (
          g.participants.has(interaction.user.id) &&
          g.state === "answering"
        ) {
          game = g;
          break;
        }
      }
      if (!game) {
        return interaction.reply({
          content: "Error submitting answer. Game not found.",
          ephemeral: true,
        });
      }

      const answer = interaction.fields.getTextInputValue("answerInput");
      game.answers.set(interaction.user.id, answer);

      await interaction.reply({
        content:
          "Got it! Your answer has been recorded. ✅\nWaiting for other players...",
        ephemeral: true,
      });

      // Check if all answers are in
      if (game.answers.size === game.participants.size) {
        proceedToVoting(game, client, activeGames);
      }
    }
    return;
  }

  // 4. Handle Select Menus (Voting)
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "voteMenu") {
      const { channelId, user } = interaction;
      const game = activeGames.get(channelId);

      if (!game || game.state !== "voting") {
        return interaction.reply({
          content: "It is not time to vote!",
          ephemeral: true,
        });
      }
      if (!game.participants.has(user.id)) {
        return interaction.reply({
          content: "You are not a participant in this game.",
          ephemeral: true,
        });
      }
      if (game.votes.has(user.id)) {
        return interaction.reply({
          content: "You have already voted.",
          ephemeral: true,
        });
      }

      const votedId = interaction.values[0];
      game.votes.set(user.id, votedId);
      const votedUser = game.participants.get(votedId);

      await interaction.reply({
        content: `You have voted for **${votedUser.username}**.`,
        ephemeral: true,
      });

      // Check if all votes are in
      if (game.votes.size === game.participants.size) {
        proceedToReveal(game, client, activeGames);
      }
    }
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
