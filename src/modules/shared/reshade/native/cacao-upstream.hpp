// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see cacao-MIT.txt.
// Exact declarations and constant functions from the pinned original CACAO.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
namespace macfx::cacao_host {
using FfxFloat32x4x4=float[16];
typedef enum FfxCacaoQuality {
	FFX_CACAO_QUALITY_LOWEST  = 0,
	FFX_CACAO_QUALITY_LOW     = 1,
	FFX_CACAO_QUALITY_MEDIUM  = 2,
	FFX_CACAO_QUALITY_HIGH    = 3,
	FFX_CACAO_QUALITY_HIGHEST = 4,
} FfxCacaoQuality;
typedef struct FfxCacaoSettings {
	float           radius;                            ///< [0.0,  ~ ] World (view) space size of the occlusion sphere.
	float           shadowMultiplier;                  ///< [0.0, 5.0] Effect strength linear multiplier.
	float           shadowPower;                       ///< [0.5, 5.0] Effect strength pow modifier.
	float           shadowClamp;                       ///< [0.0, 1.0] Effect max limit (applied after multiplier but before blur).
	float           horizonAngleThreshold;             ///< [0.0, 0.2] Limits self-shadowing (makes the sampling area less of a hemisphere, more of a spherical cone, to avoid self-shadowing and various artifacts due to low tessellation and depth buffer imprecision, etc.).
	float           fadeOutFrom;                       ///< [0.0,  ~ ] Distance to start fading out the effect.
	float           fadeOutTo;                         ///< [0.0,  ~ ] Distance at which the effect is faded out.
	FfxCacaoQuality qualityLevel;                      ///<            Effect quality, affects number of taps etc.
	float           adaptiveQualityLimit;              ///< [0.0, 1.0] (only for quality level FFX_CACAO_QUALITY_HIGHEST).
	uint32_t        blurPassCount;                     ///< [  0,   8] Number of edge-sensitive smart blur passes to apply.
	float           sharpness;                         ///< [0.0, 1.0] How much to bleed over edges; 1: not at all, 0.5: half-half; 0.0: completely ignore edges.
	float           temporalSupersamplingAngleOffset;  ///< [0.0,  PI] Used to rotate sampling kernel; If using temporal AA / supersampling, suggested to rotate by ( (frame%3)/3.0*PI ) or similar. Kernel is already symmetrical, which is why we use PI and not 2*PI.
	float           temporalSupersamplingRadiusOffset; ///< [0.0, 2.0] Used to scale sampling kernel; If using temporal AA / supersampling, suggested to scale by ( 1.0f + (((frame%3)-1.0)/3.0)*0.1 ) or similar.
	float           detailShadowStrength;              ///< [0.0, 5.0] Used for high-res detail AO using neighboring depth pixels: adds a lot of detail but also reduces temporal stability (adds aliasing).
	bool            generateNormals;                   ///< This option should be set to FFX_CACAO_TRUE if FidelityFX-CACAO should reconstruct a normal buffer from the depth buffer. It is required to be FFX_CACAO_TRUE if no normal buffer is provided.
	float           bilateralSigmaSquared;             ///< [0.0,  ~ ] Sigma squared value for use in bilateral upsampler giving Gaussian blur term. Should be greater than 0.0.
	float           bilateralSimilarityDistanceSigma;  ///< [0.0,  ~ ] Sigma squared value for use in bilateral upsampler giving similarity weighting for neighbouring pixels. Should be greater than 0.0.
} FfxCacaoSettings;
static const FfxCacaoSettings FFX_CACAO_DEFAULT_SETTINGS = {
	/* radius                            */ 1.2f,
	/* shadowMultiplier                  */ 1.0f,
	/* shadowPower                       */ 1.50f,
	/* shadowClamp                       */ 0.98f,
	/* horizonAngleThreshold             */ 0.06f,
	/* fadeOutFrom                       */ 50.0f,
	/* fadeOutTo                         */ 300.0f,
	/* qualityLevel                      */ FFX_CACAO_QUALITY_HIGHEST,
	/* adaptiveQualityLimit              */ 0.45f,
	/* blurPassCount                     */ 2,
	/* sharpness                         */ 0.98f,
	/* temporalSupersamplingAngleOffset  */ 0.0f,
	/* temporalSupersamplingRadiusOffset */ 0.0f,
	/* detailShadowStrength              */ 0.5f,
	/* generateNormals                   */ false,
	/* bilateralSigmaSquared             */ 5.0f,
	/* bilateralSimilarityDistanceSigma  */ 0.01f,
};
typedef struct FfxCacaoConstants {
	float                   DepthUnpackConsts[2];	/// Multiply and add values for clip to view depth conversion.							
	float                   CameraTanHalfFOV[2];	/// tan(fov/2) for the x and y dimensions.

	float                   NDCToViewMul[2];	/// Multiplication value for normalized device coordinates (NDC) to View conversion.
	float                   NDCToViewAdd[2];	/// Addition value for NDC to view conversion.

	float                   DepthBufferUVToViewMul[2];	/// Multiplication value for the depth buffer's UV to View conversion.
	float                   DepthBufferUVToViewAdd[2];	/// Addition value for the depth buffer's UV to view conversion.

	float                   EffectRadius;	/// The radius in world space of the occlusion sphere. A larger radius will make further objects contribute to the ambient occlusion of a point.
	float                   EffectShadowStrength;	/// The linear multiplier for shadows. Higher values intensify the shadow.
	float                   EffectShadowPow;	/// The exponent for shadow values. Larger values create darker shadows.
	float                   EffectShadowClamp;	/// Clamps the shadow values to be within a certain range.

	float                   EffectFadeOutMul;	/// Multiplication value for effect fade out.
	float                   EffectFadeOutAdd;	/// Addition value for effect fade out.
	float                   EffectHorizonAngleThreshold;	/// Minimum angle necessary between geometry and a point to create occlusion. Adjusting this value helps reduce self-shadowing.
	float                   EffectSamplingRadiusNearLimitRec;	/// Default: EffectRadius*1.2. Used to set limit on the sampling disk size when near.

	float                   DepthPrecisionOffsetMod;	/// Default: 0.9992. Offset used to prevent artifacts due to imprecision.
	float                   NegRecEffectRadius;	/// Negative reciprocal of the effect radius.
	float                   LoadCounterAvgDiv;	/// Multiplier value to get average from loadcounter value.
	float                   AdaptiveSampleCountLimit;	/// Limits the total number of samples taken at adaptive quality levels.

	float                   InvSharpness;	/// The sharpness controls how much blur should bleed over edges.
	int                     BlurNumPasses;	/// Number of blur passes. Default uses 4, with lowest quality using 2.
	float                   BilateralSigmaSquared;	/// Only affects downsampled SSAO. Higher values create a larger blur.
	float                   BilateralSimilarityDistanceSigma;	/// Only affects downsampled SSAO. Lower values create sharper edges.

	float                   PatternRotScaleMatrices[4][5][4];	/// Sampling pattern rotation/scale matrices.

	float                   NormalsUnpackMul;	/// Multiplication value to unpack normals. Set to 1 if normals are already in [-1,1] range.
	float                   NormalsUnpackAdd;	/// Addition value to unpack normals. Set to 0 if normals are already in [-1,1]range.
	float                   DetailAOStrength;	/// Adds in more detailed shadows based on edges. These are less temporally stable.
	float                   Dummy0;

	float                   SSAOBufferDimensions[2];	/// Dimensions of SSAO buffer.
	float                   SSAOBufferInverseDimensions[2];

	float                   DepthBufferDimensions[2];	/// Dimensions of the depth buffer.
	float                   DepthBufferInverseDimensions[2];

	int                     DepthBufferOffset[2];	/// Default is (0,0). Read offset for depth buffer.
    int						Pad[2];
	float                   PerPassFullResUVOffset[4*4];	/// UV Offsets used in adaptive approach.

	float                   InputOutputBufferDimensions[2];	/// Dimensions of the output AO buffer.
	float                   InputOutputBufferInverseDimensions[2];

	float                   ImportanceMapDimensions[2];	/// Dimensions of the importance map.
	float                   ImportanceMapInverseDimensions[2];

	float                   DeinterleavedDepthBufferDimensions[2];	/// Dimensions of the deinterleaved depth buffer.
	float                   DeinterleavedDepthBufferInverseDimensions[2];

	float                   DeinterleavedDepthBufferOffset[2];	/// Default is (0,0). Read offset for the deinterleaved depth buffer.
	float                   DeinterleavedDepthBufferNormalisedOffset[2];	/// Default is (0,0). Normalized read offset for the deinterleaved depth buffer. 

	FfxFloat32x4x4       NormalsWorldToViewspaceMatrix;	/// Normal matrix.

} FfxCacaoConstants;
typedef struct FfxCacaoBufferSizeInfo {
	uint32_t inputOutputBufferWidth;            ///< width of the input/output buffers
	uint32_t inputOutputBufferHeight;           ///< height of the input/output buffers

	uint32_t ssaoBufferWidth;                   ///< width of the ssao buffer
	uint32_t ssaoBufferHeight;                  ///< height of the ssao buffer

	uint32_t depthBufferXOffset;                ///< x-offset to use when sampling depth buffer
	uint32_t depthBufferYOffset;                ///< y-offset to use when sampling depth buffer

	uint32_t depthBufferWidth;                  ///< width of the passed in depth buffer
	uint32_t depthBufferHeight;                 ///< height of the passed in depth buffer

	uint32_t deinterleavedDepthBufferXOffset;   ///< x-offset to use when sampling de-interleaved depth buffer
	uint32_t deinterleavedDepthBufferYOffset;   ///< y-offset to use when sampling de-interleaved depth buffer

	uint32_t deinterleavedDepthBufferWidth;     ///< width of the de-interleaved depth buffer
	uint32_t deinterleavedDepthBufferHeight;    ///< height of the de-interleaved depth buffer

	uint32_t importanceMapWidth;                ///< width of the importance map buffer
	uint32_t importanceMapHeight;               ///< height of the importance map buffer

	uint32_t downsampledSsaoBufferWidth;        ///< width of the downsampled ssao buffer
	uint32_t downsampledSsaoBufferHeight;       ///< height of the downsampled ssao buffer
} FfxCacaoBufferSizeInfo;
static const FfxFloat32x4x4 FFX_CACAO_IDENTITY_MATRIX = {
    
    1.0f, 0.0f, 0.0f, 0.0f,
    0.0f, 1.0f, 0.0f, 0.0f,
    0.0f, 0.0f, 1.0f, 0.0f,
    0.0f, 0.0f, 0.0f, 1.0f
    
};
#define FFX_CACAO_ARRAY_SIZE(xs) (sizeof(xs)/sizeof(xs[0]))
#define FFX_CACAO_COS cosf
#define FFX_CACAO_SIN sinf
#define FFX_CACAO_MIN(x,y) (((x)<(y))?(x):(y))
#define FFX_CACAO_MAX(x,y) (((x)>(y))?(x):(y))
#define FFX_CACAO_CLAMP(x,a,b) FFX_CACAO_MIN(FFX_CACAO_MAX(x,a),b)
#define MATRIX_ROW_MAJOR_ORDER 1
void ffxCacaoUpdateBufferSizeInfo(const uint32_t width, const uint32_t height, const bool useDownsampledSsao, FfxCacaoBufferSizeInfo* bsi)
{
    const uint32_t halfWidth     = (width + 1) / 2;
    const uint32_t halfHeight    = (height + 1) / 2;
    const uint32_t quarterWidth  = (halfWidth + 1) / 2;
    const uint32_t quarterHeight = (halfHeight + 1) / 2;
    const uint32_t eighthWidth   = (quarterWidth + 1) / 2;
    const uint32_t eighthHeight  = (quarterHeight + 1) / 2;

    const uint32_t depthBufferWidth         = width;
    const uint32_t depthBufferHeight        = height;
    const uint32_t depthBufferHalfWidth     = halfWidth;
    const uint32_t depthBufferHalfHeight    = halfHeight;
    const uint32_t depthBufferQuarterWidth  = quarterWidth;
    const uint32_t depthBufferQuarterHeight = quarterHeight;

    const uint32_t depthBufferXOffset        = 0;
    const uint32_t depthBufferYOffset        = 0;
    const uint32_t depthBufferHalfXOffset    = 0;
    const uint32_t depthBufferHalfYOffset    = 0;
    const uint32_t depthBufferQuarterXOffset = 0;
    const uint32_t depthBufferQuarterYOffset = 0;

    bsi->inputOutputBufferWidth  = width;
    bsi->inputOutputBufferHeight = height;
    bsi->depthBufferXOffset      = depthBufferXOffset;
    bsi->depthBufferYOffset      = depthBufferYOffset;
    bsi->depthBufferWidth        = depthBufferWidth;
    bsi->depthBufferHeight       = depthBufferHeight;

    if (useDownsampledSsao)
    {
        bsi->ssaoBufferWidth                 = quarterWidth;
        bsi->ssaoBufferHeight                = quarterHeight;
        bsi->deinterleavedDepthBufferXOffset = depthBufferQuarterXOffset;
        bsi->deinterleavedDepthBufferYOffset = depthBufferQuarterYOffset;
        bsi->deinterleavedDepthBufferWidth   = depthBufferQuarterWidth;
        bsi->deinterleavedDepthBufferHeight  = depthBufferQuarterHeight;
        bsi->importanceMapWidth              = eighthWidth;
        bsi->importanceMapHeight             = eighthHeight;
        bsi->downsampledSsaoBufferWidth      = halfWidth;
        bsi->downsampledSsaoBufferHeight     = halfHeight;
    }
    else
    {
        bsi->ssaoBufferWidth                 = halfWidth;
        bsi->ssaoBufferHeight                = halfHeight;
        bsi->deinterleavedDepthBufferXOffset = depthBufferHalfXOffset;
        bsi->deinterleavedDepthBufferYOffset = depthBufferHalfYOffset;
        bsi->deinterleavedDepthBufferWidth   = depthBufferHalfWidth;
        bsi->deinterleavedDepthBufferHeight  = depthBufferHalfHeight;
        bsi->importanceMapWidth              = quarterWidth;
        bsi->importanceMapHeight             = quarterHeight;
        bsi->downsampledSsaoBufferWidth      = 1;
        bsi->downsampledSsaoBufferHeight     = 1;
    }
}

void ffxCacaoUpdateConstants(FfxCacaoConstants*            consts,
                             const FfxCacaoSettings*       settings,
                             const FfxCacaoBufferSizeInfo* bufferSizeInfo,
                             const FfxFloat32x4x4*         proj,
                             const FfxFloat32x4x4*         normalsToView,
                             const float                   NormalUnPackMul,
                             const float                   NormalUnPackAdd)
{
    consts->BilateralSigmaSquared            = settings->bilateralSigmaSquared;
    consts->BilateralSimilarityDistanceSigma = settings->bilateralSimilarityDistanceSigma;

    if (settings->generateNormals)
    {
        memcpy(consts->NormalsWorldToViewspaceMatrix, FFX_CACAO_IDENTITY_MATRIX, sizeof(consts->NormalsWorldToViewspaceMatrix));
    }
    else
    {
        memcpy(consts->NormalsWorldToViewspaceMatrix, *normalsToView, sizeof(consts->NormalsWorldToViewspaceMatrix));
    }
    // used to get average load per pixel; 9.0 is there to compensate for only doing every 9th InterlockedAdd in PSPostprocessImportanceMapB for performance reasons
    consts->LoadCounterAvgDiv = 9.0f / (float)(bufferSizeInfo->importanceMapWidth * bufferSizeInfo->importanceMapHeight * 255.0);

    const float depthLinearizeMul = (MATRIX_ROW_MAJOR_ORDER) ? (-(*proj)[14])
                                                       : (-(*proj)[11]);  // float depthLinearizeMul = ( clipFar * clipNear ) / ( clipFar - clipNear );
    float depthLinearizeAdd = (MATRIX_ROW_MAJOR_ORDER) ? ((*proj)[10]) 
                                                       : ((*proj)[10]);  // float depthLinearizeAdd = clipFar / ( clipFar - clipNear );
    // correct the handedness issue. need to make sure this below is correct, but I think it is.
    if (depthLinearizeMul * depthLinearizeAdd < 0)
        depthLinearizeAdd = -depthLinearizeAdd;
    consts->DepthUnpackConsts[0] = depthLinearizeMul;
    consts->DepthUnpackConsts[1] = depthLinearizeAdd;

    const float tanHalfFOVY           = 1.0f / (*proj)[5];  // = tanf( drawContext.Camera.GetYFOV( ) * 0.5f );
    const float tanHalfFOVX           = 1.0F / (*proj)[0];  // = tanHalfFOVY * drawContext.Camera.GetAspect( );
    consts->CameraTanHalfFOV[0] = tanHalfFOVX;
    consts->CameraTanHalfFOV[1] = tanHalfFOVY;

    consts->NDCToViewMul[0] = consts->CameraTanHalfFOV[0] * 2.0f;
    consts->NDCToViewMul[1] = consts->CameraTanHalfFOV[1] * -2.0f;
    consts->NDCToViewAdd[0] = consts->CameraTanHalfFOV[0] * -1.0f;
    consts->NDCToViewAdd[1] = consts->CameraTanHalfFOV[1] * 1.0f;

    const float ratio  = ((float)bufferSizeInfo->inputOutputBufferWidth) / ((float)bufferSizeInfo->depthBufferWidth);
    const float border = (1.0f - ratio) / 2.0f;
    for (int i = 0; i < FFX_CACAO_ARRAY_SIZE(consts->DepthBufferUVToViewMul); ++i)
    {
        consts->DepthBufferUVToViewMul[i] = consts->NDCToViewMul[i] / ratio;
        consts->DepthBufferUVToViewAdd[i] = consts->NDCToViewAdd[i] - consts->NDCToViewMul[i] * border / ratio;
    }

    consts->EffectRadius                = FFX_CACAO_CLAMP(settings->radius, 0.0f, 100000.0f);
    consts->EffectShadowStrength        = FFX_CACAO_CLAMP(settings->shadowMultiplier * 4.3f, 0.0f, 10.0f);
    consts->EffectShadowPow             = FFX_CACAO_CLAMP(settings->shadowPower, 0.0f, 10.0f);
    consts->EffectShadowClamp           = FFX_CACAO_CLAMP(settings->shadowClamp, 0.0f, 1.0f);
    consts->EffectFadeOutMul            = -1.0f / (settings->fadeOutTo - settings->fadeOutFrom);
    consts->EffectFadeOutAdd            = settings->fadeOutFrom / (settings->fadeOutTo - settings->fadeOutFrom) + 1.0f;
    consts->EffectHorizonAngleThreshold = FFX_CACAO_CLAMP(settings->horizonAngleThreshold, 0.0f, 1.0f);

    // 1.2 seems to be around the best trade off - 1.0 means on-screen radius will stop/slow growing when the camera is at 1.0 distance, so, depending on FOV, basically filling up most of the screen
    // This setting is viewspace-dependent and not screen size dependent intentionally, so that when you change FOV the effect stays (relatively) similar.
    float effectSamplingRadiusNearLimit = (settings->radius * 1.2f);

    // if the depth precision is switched to 32bit float, this can be set to something closer to 1 (0.9999 is fine)
    consts->DepthPrecisionOffsetMod = 0.9992f;

    // Special settings for lowest quality level - just nerf the effect a tiny bit
    if (settings->qualityLevel <= FFX_CACAO_QUALITY_LOW)
    {
        //consts.EffectShadowStrength     *= 0.9f;
        effectSamplingRadiusNearLimit *= 1.50f;

        if (settings->qualityLevel == FFX_CACAO_QUALITY_LOWEST)
            consts->EffectRadius *= 0.8f;
    }

    effectSamplingRadiusNearLimit /= tanHalfFOVY;  // to keep the effect same regardless of FOV

    consts->EffectSamplingRadiusNearLimitRec = 1.0f / effectSamplingRadiusNearLimit;

    consts->AdaptiveSampleCountLimit = settings->adaptiveQualityLimit;

    consts->NegRecEffectRadius = -1.0f / consts->EffectRadius;

    consts->InvSharpness = FFX_CACAO_CLAMP(1.0f - settings->sharpness, 0.0f, 1.0f);

    consts->DetailAOStrength = settings->detailShadowStrength;

    // set buffer size constants.
    consts->SSAOBufferDimensions[0]        = (float)bufferSizeInfo->ssaoBufferWidth;
    consts->SSAOBufferDimensions[1]        = (float)bufferSizeInfo->ssaoBufferHeight;
    consts->SSAOBufferInverseDimensions[0] = 1.0f / ((float)bufferSizeInfo->ssaoBufferWidth);
    consts->SSAOBufferInverseDimensions[1] = 1.0f / ((float)bufferSizeInfo->ssaoBufferHeight);

    consts->DepthBufferDimensions[0]        = (float)bufferSizeInfo->depthBufferWidth;
    consts->DepthBufferDimensions[1]        = (float)bufferSizeInfo->depthBufferHeight;
    consts->DepthBufferInverseDimensions[0] = 1.0f / ((float)bufferSizeInfo->depthBufferWidth);
    consts->DepthBufferInverseDimensions[1] = 1.0f / ((float)bufferSizeInfo->depthBufferHeight);

    consts->DepthBufferOffset[0] = bufferSizeInfo->depthBufferXOffset;
    consts->DepthBufferOffset[1] = bufferSizeInfo->depthBufferYOffset;

    consts->InputOutputBufferDimensions[0]        = (float)bufferSizeInfo->inputOutputBufferWidth;
    consts->InputOutputBufferDimensions[1]        = (float)bufferSizeInfo->inputOutputBufferHeight;
    consts->InputOutputBufferInverseDimensions[0] = 1.0f / ((float)bufferSizeInfo->inputOutputBufferWidth);
    consts->InputOutputBufferInverseDimensions[1] = 1.0f / ((float)bufferSizeInfo->inputOutputBufferHeight);

    consts->ImportanceMapDimensions[0]        = (float)bufferSizeInfo->importanceMapWidth;
    consts->ImportanceMapDimensions[1]        = (float)bufferSizeInfo->importanceMapHeight;
    consts->ImportanceMapInverseDimensions[0] = 1.0f / ((float)bufferSizeInfo->importanceMapWidth);
    consts->ImportanceMapInverseDimensions[1] = 1.0f / ((float)bufferSizeInfo->importanceMapHeight);

    consts->DeinterleavedDepthBufferDimensions[0]        = (float)bufferSizeInfo->deinterleavedDepthBufferWidth;
    consts->DeinterleavedDepthBufferDimensions[1]        = (float)bufferSizeInfo->deinterleavedDepthBufferHeight;
    consts->DeinterleavedDepthBufferInverseDimensions[0] = 1.0f / ((float)bufferSizeInfo->deinterleavedDepthBufferWidth);
    consts->DeinterleavedDepthBufferInverseDimensions[1] = 1.0f / ((float)bufferSizeInfo->deinterleavedDepthBufferHeight);

    consts->DeinterleavedDepthBufferOffset[0] = (float)bufferSizeInfo->deinterleavedDepthBufferXOffset;
    consts->DeinterleavedDepthBufferOffset[1] = (float)bufferSizeInfo->deinterleavedDepthBufferYOffset;
    consts->DeinterleavedDepthBufferNormalisedOffset[0] =
        ((float)bufferSizeInfo->deinterleavedDepthBufferXOffset) / ((float)bufferSizeInfo->deinterleavedDepthBufferWidth);
    consts->DeinterleavedDepthBufferNormalisedOffset[1] =
        ((float)bufferSizeInfo->deinterleavedDepthBufferYOffset) / ((float)bufferSizeInfo->deinterleavedDepthBufferHeight);

    consts->NormalsUnpackMul = NormalUnPackMul;
    consts->NormalsUnpackAdd = NormalUnPackAdd;

    for (int passId = 0; passId < FFX_CACAO_ARRAY_SIZE(consts->PerPassFullResUVOffset) / 4; ++passId)
    {
        consts->PerPassFullResUVOffset[4 * passId + 0] = ((float)(passId % 2)) / (float)bufferSizeInfo->ssaoBufferWidth;
        consts->PerPassFullResUVOffset[4 * passId + 1] = ((float)(passId / 2)) / (float)bufferSizeInfo->ssaoBufferHeight;
        consts->PerPassFullResUVOffset[4 * passId + 2] = 0;
        consts->PerPassFullResUVOffset[4 * passId + 3] = 0;
    }

    consts->BlurNumPasses = settings->qualityLevel == FFX_CACAO_QUALITY_LOWEST ? 2 : 4;

    const float additionalAngleOffset =
        settings
            ->temporalSupersamplingAngleOffset;  // if using temporal supersampling approach (like "Progressive Rendering Using Multi-frame Sampling" from GPU Pro 7, etc.)
    const float additionalRadiusScale =
        settings
            ->temporalSupersamplingRadiusOffset;  // if using temporal supersampling approach (like "Progressive Rendering Using Multi-frame Sampling" from GPU Pro 7, etc.)
            
    const int spmap[5]{0, 1, 4, 3, 2};
    const float PI = 3.1415926535897932384626433832795f;
    const int subPassCount = FFX_CACAO_ARRAY_SIZE(consts->PatternRotScaleMatrices[0]);
    for (int passId = 0; passId < FFX_CACAO_ARRAY_SIZE(consts->PatternRotScaleMatrices); ++passId)
    {
        for (int subPass = 0; subPass < subPassCount; subPass++)
        {
            const int a = passId;

            const int b = spmap[subPass];

            float ca, sa;
            const float angle0 = ((float)a + (float)b / (float)subPassCount) * (PI) * 0.5f;

            ca = FFX_CACAO_COS(angle0);
            sa = FFX_CACAO_SIN(angle0);

            const float scale = 1.0f + (a - 1.5f + (b - (subPassCount - 1.0f) * 0.5f) / (float)subPassCount) * 0.07f;

            consts->PatternRotScaleMatrices[passId][subPass][0] = scale * ca;
            consts->PatternRotScaleMatrices[passId][subPass][1] = scale * -sa;
            consts->PatternRotScaleMatrices[passId][subPass][2] = -scale * sa;
            consts->PatternRotScaleMatrices[passId][subPass][3] = -scale * ca;
        }
    }
}


#undef FFX_CACAO_ARRAY_SIZE
#undef FFX_CACAO_COS
#undef FFX_CACAO_SIN
#undef FFX_CACAO_MIN
#undef FFX_CACAO_MAX
#undef FFX_CACAO_CLAMP
#undef MATRIX_ROW_MAJOR_ORDER
}
