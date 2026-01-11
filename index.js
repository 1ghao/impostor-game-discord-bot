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
  MessageFlags,
} from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Import Impostor logic
import {
  startRound,
  proceedToVoting,
  proceedToReveal,
} from "./game-managers/impostor-manager.js";

// Import Wavelength logic
import {
  initWavelengthRound,
  startPsychicPhase,
  handleClueSubmission,
  revealWavelengthResult,
} from "./game-managers/wavelength-manager.js";

// Import lobby helpers
import { createImpostorLobbyEmbed } from "./commands/startImpostorGame.js";
import { createWavelengthLobbyEmbed } from "./commands/startWavelengthGame.js";

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
const threadToGameMap = new Map();

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
      await command.execute(interaction, activeGames, threadToGameMap);
    } catch (error) {
      console.error(error);
      await interaction.reply({
        content: "There was an error while executing this command!",
        flags: [MessageFlags.Ephemeral],
      });
    }
    return;
  }

  // 2. Handle Buttons
  if (interaction.isButton()) {
    const { customId, user, channel, channelId } = interaction;
    let game;
    let mainChannelId;

    // Find game
    if (channel.isThread()) {
      mainChannelId = threadToGameMap.get(channelId);
      if (!mainChannelId) {
        return interaction.reply({
          content: "Error finding game. This thread may be invalid or expired.",
          flags: [MessageFlags.Ephemeral],
        });
      }
      game = activeGames.get(mainChannelId);
    } else {
      game = activeGames.get(channelId);
      mainChannelId = channelId;
    }

    if (!game) {
      return interaction.reply({
        content:
          "I couldn't find an active game for this interaction. It may have been stopped.",
        flags: [MessageFlags.Ephemeral],
      });
    }

    // Logic for THREAD buttons
    if (channel.isThread()) {
      const parts = customId.split("_");
      const round = parts.at(-1);
      // Validate round
      if (!game || game.roundNumber.toString() !== round) {
        return interaction.reply({
          content:
            "This button is from a previous round and is no longer active.",
          flags: [MessageFlags.Ephemeral],
        });
      }
      // Impostor game
      if (customId.startsWith("submitAnswerButton_")) {
        // Validate state
        if (game.state !== "answering") {
          return interaction.reply({
            content: "It is not time to answer!",
            flags: [MessageFlags.Ephemeral],
          });
        }
        // Validate user
        if (!game.participants.has(user.id)) {
          return interaction.reply({
            content: "You are not part of this game.",
            flags: [MessageFlags.Ephemeral],
          });
        }
        // Validate submission
        if (game.answers.has(user.id)) {
          return interaction.reply({
            content: "You have already submitted an answer for this round.",
            flags: [MessageFlags.Ephemeral],
          });
        }

        const modal = new ModalBuilder()
          .setCustomId(`answerModal_${game.roundNumber}`)
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

      // Wavelength game
      if (customId.startsWith("wl_giveClue_")) {
        if (user.id !== game.psychicId) {
          return interaction.reply({
            content: "You aren't the one deciding",
            flags: [MessageFlags.Ephemeral],
          });
        }

        const modal = new ModalBuilder()
          .setCustomId(`wl_clueModal_${game.roundNumber}`)
          .setTitle("Give Clue");
        let placeholderText = `${game.spectrum.left} <-> ${game.spectrum.right}`;

        const input = new TextInputBuilder()
          .setCustomId("clueInput")
          .setLabel("Enter your clue")
          .setPlaceholder(placeholderText)
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }
    }

    // === Logic for MAIN CHANNEL buttons ===
    if (!channel.isThread()) {
      // --- Lobby Buttons ---
      if (game.state === "lobby") {
        if (customId === "joinGame") {
          game.participants.set(user.id, user);
          const embed =
            game.type == "wavelength"
              ? createWavelengthLobbyEmbed(
                  game.participants.get(game.hostId),
                  game.participants
                )
              : createImpostorLobbyEmbed(
                  game.participants.get(game.hostId),
                  game.participants
                );
          await game.lobbyMessage.edit({ embeds: [embed] });
          return interaction.reply({
            content: "You have joined the game! 🎉",
            flags: [MessageFlags.Ephemeral],
          });
        }

        if (customId === "leaveGame") {
          if (user.id === game.hostId) {
            return interaction.reply({
              content: "The host cannot leave! Use /stopgame to end the game.",
              flags: [MessageFlags.Ephemeral],
            });
          }
          game.participants.delete(user.id);
          const embed =
            game.type === "wavelength"
              ? createWavelengthLobbyEmbed(
                  game.participants.get(game.hostId),
                  game.participants
                )
              : createImpostorLobbyEmbed(
                  game.participants.get(game.hostId),
                  game.participants
                );
          await game.lobbyMessage.edit({ embeds: [embed] });
          return interaction.reply({
            content: "You have left the game.",
            flags: [MessageFlags.Ephemeral],
          });
        }

        if (customId === "startImpostor") {
          // HOST CHECK
          if (user.id !== game.hostId) {
            return interaction.reply({
              content: "Only the host can start the game!",
              flags: [MessageFlags.Ephemeral],
            });
          }
          // PARTICIPANT CHECK
          if (game.participants.size < 1) {
            return interaction.reply({
              content: "You need at least 3 players to start!",
              flags: [MessageFlags.Ephemeral],
            });
          }

          await interaction.deferUpdate(); // Acknowledge the button click
          await startRound(game, client, activeGames, threadToGameMap);
          return;
        }

        if (customId === "startWavelength") {
          if (user.id !== game.hostId)
            return interaction.reply({
              content: "Host only.",
              flags: [MessageFlags.Ephemeral],
            });
          if (game.participants.size < 2)
            return interaction.reply({
              content: "Need 2+ players.",
              flags: [MessageFlags.Ephemeral],
            });
          await interaction.deferUpdate();
          // Start fresh, asking for new spectrum
          await initWavelengthRound(
            game,
            client,
            activeGames,
            threadToGameMap,
            false
          );
          return;
        }
      }

      // Wavelength logic

      if (customId.startsWith("wl_setSpectrum_")) {
        if (user.id !== game.hostId)
          return interaction.reply({
            content: "Host only.",
            flags: [MessageFlags.Ephemeral],
          });
        const modal = new ModalBuilder()
          .setCustomId(`wl_spectrumModal_${game.roundNumber}`)
          .setTitle("Set Spectrum");
        const left = new TextInputBuilder()
          .setCustomId("leftInput")
          .setLabel("Left (0)")
          .setStyle(TextInputStyle.Short);
        const right = new TextInputBuilder()
          .setCustomId("rightInput")
          .setLabel("Right (100)")
          .setStyle(TextInputStyle.Short);
        modal.addComponents(
          new ActionRowBuilder().addComponents(left),
          new ActionRowBuilder().addComponents(right)
        );
        await interaction.showModal(modal);
        return;
      }

      if (customId.startsWith("wl_guess_")) {
        if (user.id === game.psychicId)
          return interaction.reply({
            content: "Psychic cannot guess!",
            flags: [MessageFlags.Ephemeral],
          });
        if (game.guesses.has(user.id))
          return interaction.reply({
            content: "Already guessed!",
            flags: [MessageFlags.Ephemeral],
          });

        const modal = new ModalBuilder()
          .setCustomId(`wl_guessModal_${game.roundNumber}`)
          .setTitle("Your Guess (0-100)");
        const input = new TextInputBuilder()
          .setCustomId("guessInput")
          .setLabel("Number:")
          .setStyle(TextInputStyle.Short);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      // --- End-of-Game Buttons ---
      if (game.state === "finished") {
        // HOST CHECK
        if (user.id !== game.hostId) {
          return interaction.reply({
            content: "Only the host can restart or end the game.",
            flags: [MessageFlags.Ephemeral],
          });
        }

        //Impostor play again
        if (customId === "playAgainButton") {
          await interaction.update({
            content: "Starting a new round with the same players...",
            embeds: [],
            components: [],
          });
          await startRound(game, client, activeGames, threadToGameMap);
        }

        //Wavelength play again

        //new spectrum
        if (customId === "wl_nextRound_new") {
          if (user.id !== game.hostId)
            return interaction.reply({
              content: "Host only.",
              flags: [MessageFlags.Ephemeral],
            });
          await interaction.update({
            content: "Next round (New Spectrum)...",
            embeds: [],
            components: [],
          });
          await initWavelengthRound(
            game,
            client,
            activeGames,
            threadToGameMap,
            false
          );
          return;
        }

        // keeping spectrum
        if (customId === "wl_nextRound_same") {
          if (user.id !== game.hostId)
            return interaction.reply({
              content: "Host only.",
              flags: [MessageFlags.Ephemeral],
            });
          await interaction.update({
            content: "Next round (Same Spectrum)...",
            embeds: [],
            components: [],
          });
          await initWavelengthRound(
            game,
            client,
            activeGames,
            threadToGameMap,
            true
          );
          return;
        }

        if (customId === "endGameButton") {
          await interaction.update({
            content: "This game has ended. Thanks for playing!",
            embeds: [],
            components: [],
          });

          // Cleanup threads
          if (game.activeThreads) {
            for (const threadId of game.activeThreads.values()) {
              threadToGameMap.delete(threadId);
              try {
                const thread = await client.channels.fetch(threadId);
                await thread.delete("Game ended.");
              } catch (e) {
                console.error("Could not delete threads:", e);
              }
            }
          }
          activeGames.delete(channelId);
        }
        return;
      }
    }
  }

  // 3. Handle Modal Submissions
  if (interaction.isModalSubmit()) {
    const { customId, channelId } = interaction;

    let game;
    let mainChannelId;

    // Check if modal came from inside a thread (Impostor Answer or Wavelength Clue)
    if (interaction.channel.isThread()) {
      mainChannelId = threadToGameMap.get(channelId);
    } else {
      // Or from main channel (Wavelength Spectrum or Guess)
      mainChannelId = channelId;
    }

    if (mainChannelId) game = activeGames.get(mainChannelId);

    if (!game)
      return interaction.reply({
        content: "Game not found.",
        flags: [MessageFlags.Ephemeral],
      });

    const parts = customId.split("_");
    const round = parts.at(-1);
    if (game.roundNumber.toString() !== round)
      return interaction.reply({
        content: "Expired modal.",
        flags: [MessageFlags.Ephemeral],
      });

    // Impostor modal
    if (customId.startsWith("answerModal_")) {
      if (!mainChannelId) {
        return interaction.reply({
          content: "Error finding game. This modal may be invalid.",
          flags: [MessageFlags.Ephemeral],
        });
      }

      if (!game || game.roundNumber.toString() !== round) {
        return interaction.reply({
          content:
            "This modal is from a previous round and is no longer active.",
          flags: [MessageFlags.Ephemeral],
        });
      }

      if (game.answers.has(interaction.user.id))
        return interaction.reply({
          content: "You have already submitted an answer. Please wait...",
          flags: [MessageFlags.Ephemeral],
        });

      const answer = interaction.fields.getTextInputValue("answerInput");
      game.answers.set(interaction.user.id, answer);

      await interaction.reply({
        content:
          "Got it! Your answer has been recorded. ✅\nWaiting for other players...",
        flags: [MessageFlags.Ephemeral],
      });
      if (game.answers.size === game.participants.size)
        proceedToVoting(game, client, activeGames, threadToGameMap);
      return;
    }

    // Wavelength Modals

    if (customId.startsWith("wl_spectrumModal_")) {
      const left = interaction.fields.getTextInputValue("leftInput");
      const right = interaction.fields.getTextInputValue("rightInput");
      game.spectrum = { left, right };
      await interaction.deferUpdate();
      await startPsychicPhase(game, client, threadToGameMap);
      return;
    }

    // Psychic Clue
    if (customId.startsWith("wl_clueModal_")) {
      const clue = interaction.fields.getTextInputValue("clueInput");
      await interaction.deferUpdate();
      await handleClueSubmission(game, client, clue);
      return;
    }

    // Guess
    if (customId.startsWith("wl_guessModal_")) {
      if (!game.participants.has(interaction.user.id)) {
        return interaction.reply({
          content: "You are not a participant in this game!",
          flags: [MessageFlags.Ephemeral],
        });
      }
      const val = parseInt(interaction.fields.getTextInputValue("guessInput"));
      if (isNaN(val) || val < 0 || val > 100) {
        try {
          return await interaction.reply({
            content: "Please enter a valid number between 0 and 100.",
            flags: [MessageFlags.Ephemeral],
          });
        } catch (e) {
          console.warn("Failed to send validation error reply:", e.message);
          return;
        }
      }
      game.guesses.set(interaction.user.id, val);
      try {
        await interaction.reply({
          content: `You guessed: **${val}**`,
          flags: [MessageFlags.Ephemeral],
        });
      } catch (e) {
        console.warn("Failed to send guess confirmation:", e.message);
      }

      // Check if all players (minus psychic) guessed
      if (game.guesses.size >= game.participants.size - 1) {
        await revealWavelengthResult(
          game,
          client,
          activeGames,
          threadToGameMap
        );
      }
      return;
    }
  }

  // 4. Handle Select Menus ( Impostor Voting)
  if (interaction.isStringSelectMenu()) {
    const { customId } = interaction;
    if (interaction.customId.startsWith("voteMenu_")) {
      const parts = customId.split("_");
      const round = parts.at(-1);
      const { channelId, user } = interaction;
      const game = activeGames.get(channelId);

      if (!game || game.state !== "voting") {
        return interaction.reply({
          content: "It is not time to vote!",
          flags: [MessageFlags.Ephemeral],
        });
      }
      if (game.roundNumber.toString() !== round) {
        return interaction.reply({
          content:
            "This voting menu is from a previous round and is no longer active.  expired",
          flags: [MessageFlags.Ephemeral],
        });
      }

      if (!game.participants.has(user.id)) {
        return interaction.reply({
          content: "You are not a participant in this game.",
          flags: [MessageFlags.Ephemeral],
        });
      }
      if (game.votes.has(user.id)) {
        return interaction.reply({
          content: "You have already voted.",
          flags: [MessageFlags.Ephemeral],
        });
      }

      const votedId = interaction.values[0];
      game.votes.set(user.id, votedId);
      const votedUser = game.participants.get(votedId);

      await interaction.reply({
        content: `You have voted for **${votedUser.username}**.`,
        flags: [MessageFlags.Ephemeral],
      });

      // Check if all votes are in
      if (game.votes.size === game.participants.size) {
        proceedToReveal(game, client, activeGames, threadToGameMap);
      }
    }
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
