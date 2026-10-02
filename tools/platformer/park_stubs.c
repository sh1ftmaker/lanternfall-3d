// Lanternfall 3D: stand-ins for the parts of libsm64 that this build leaves out (no ROM, no audio engine, no model),
// plus a few accessors for the JS wrapper. Original code for this project; compiled together with the patched
// libsm64 sources by build-wasm.sh (include paths: src, src/decomp/include).
#include <stdbool.h>
#include <stdint.h>
#include "libsm64.h"
#include "decomp/include/types.h"
#include "decomp/global_state.h"
#include "decomp/shim.h"

// The audio engine is not built. The movement code still asks for sounds; they are forwarded to the host (if it
// registered a callback) as bare event numbers, and otherwise ignored.
bool g_is_audio_initialized = false;
SM64PlaySoundFunctionPtr g_play_sound_func = 0;

void play_sound( uint32_t soundBits, float *pos ) { if( g_play_sound_func ) g_play_sound_func( soundBits, pos ); }
void stop_sound( uint32_t soundBits, float *pos ) { (void)soundBits; (void)pos; }
void play_music( uint8_t player, uint16_t seqArgs, uint16_t fadeTimer ) { (void)player; (void)seqArgs; (void)fadeTimer; }
void stop_background_music( uint16_t seqId ) { (void)seqId; }
void fadeout_background_music( uint16_t arg0, uint16_t fadeOut ) { (void)arg0; (void)fadeOut; }
uint32_t gAudioRandom = 0;     // advanced by the audio engine in the game; only picks a panting sound here

#define EXPORT __attribute__((visibility("default")))

// Shared blocks for the JS wrapper (fx/platformer/sm64.js): inputs in, state + extra state out.
static struct SM64MarioInputs s_inputs;
static struct SM64MarioState s_state;
static float s_extra[24];
EXPORT struct SM64MarioInputs *park_inputs( void ) { return &s_inputs; }
EXPORT struct SM64MarioState *park_state( void ) { return &s_state; }
EXPORT float *park_extra( void ) { return s_extra; }

// One 30 Hz step, then the extra fields the character's own animation layer uses.
EXPORT void park_tick( int32_t id )
{
    sm64_mario_tick( id, &s_inputs, &s_state, 0 );
    struct MarioState *m = gMarioState;
    if( m == 0 ) return;
    struct Object *o = m->marioObj;
    float *e = s_extra;
    e[0] = m->floorHeight;           e[1] = m->ceilHeight;           e[2] = (float)m->waterLevel;
    e[3] = (float)m->actionState;    e[4] = (float)m->actionTimer;   e[5] = (float)m->actionArg;
    e[6] = (float)m->prevAction;     e[7] = m->intendedMag;          e[8] = (float)m->intendedYaw;
    e[9] = (float)m->faceAngle[0];   e[10] = (float)m->faceAngle[1]; e[11] = (float)m->faceAngle[2];
    e[12] = (float)o->header.gfx.angle[0]; e[13] = (float)o->header.gfx.angle[1]; e[14] = (float)o->header.gfx.angle[2];
    e[15] = (float)o->header.gfx.animInfo.animAccel / 65536.0f;
    e[16] = (float)o->header.gfx.animInfo.animFrameAccelAssist / 65536.0f;
    e[17] = m->floor ? m->floor->normal.x : 0.0f; e[18] = m->floor ? m->floor->normal.y : 1.0f; e[19] = m->floor ? m->floor->normal.z : 0.0f;
    e[20] = m->peakHeight;           e[21] = (float)m->input;        e[22] = m->marioBodyState ? (float)m->marioBodyState->torsoAngle[0] : 0.0f;
    e[23] = m->marioBodyState ? (float)m->marioBodyState->torsoAngle[2] : 0.0f;
}

// struct layout check for the wrapper: sizes and the offsets it relies on
EXPORT uint32_t park_layout( int32_t k )
{
    switch( k )
    {
        case 0: return sizeof( struct SM64Surface );
        case 1: return sizeof( struct SM64MarioInputs );
        case 2: return sizeof( struct SM64MarioState );
        case 3: return __builtin_offsetof( struct SM64MarioState, health );
        case 4: return __builtin_offsetof( struct SM64MarioState, action );
        case 5: return __builtin_offsetof( struct SM64MarioState, animID );
        case 6: return __builtin_offsetof( struct SM64MarioState, animFrame );
        case 7: return __builtin_offsetof( struct SM64MarioState, flags );
        case 8: return __builtin_offsetof( struct SM64MarioState, particleFlags );
        case 9: return __builtin_offsetof( struct SM64MarioState, invincTimer );
        case 10: return __builtin_offsetof( struct SM64MarioInputs, buttonA );
        case 11: return __builtin_offsetof( struct SM64Surface, vertices );
    }
    return 0;
}
